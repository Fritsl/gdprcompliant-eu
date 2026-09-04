import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256, type Evidence } from '@gc/contracts';
import {
  CanaryCorpusSchema,
  FLEET_SHIFT_SHARE,
  activeSites,
  canaryReport,
  compareSnapshots,
  formatCanaryReport,
  loadCanaryCorpus,
  rawSummaryOf,
  readSnapshots,
  snapshotDates,
  snapshotOf,
  writeSnapshot,
  type CanarySnapshot,
} from '@gc/scanner';

// The canary (T-10): a corpus of public sites with an owner, politeness and an
// exclusion list; a snapshot per site per night that separates what was observed from
// what the scanner made of it; and a day-over-day comparison that tells a site that
// changed from a scanner that changed, and raises the alarm only for the second.

const corpus = loadCanaryCorpus();
const T0 = '2026-09-04T03:17:00.000Z';

const row = (kind: Evidence['kind'], host: string, body: string): Evidence => {
  const hash = sha256(body);
  return {
    id: `${kind}:${hash.slice(0, 16)}`,
    tenantId: 't-canary',
    caseId: 'XX-00-CNRY',
    kind,
    capturedAt: T0,
    source: { url: `https://${host}/`, host, pass: 'A' },
    body,
    hash,
  };
};

const evidence = [
  row('http_request', 'www.example.dk', 'GET /'),
  row('http_request', 'cdn.example.dk', 'GET /app.js'),
  row('http_request', 'www.googletagmanager.com', 'GET /gtm.js'),
  row('http_request', 'fonts.gstatic.com', 'GET /font.woff2'),
  row(
    'cookie',
    'www.example.dk',
    JSON.stringify({ name: '_ga', domain: '.example.dk', expires: 0 }),
  ),
  row(
    'cookie',
    'www.example.dk',
    JSON.stringify({ name: 'session', domain: 'www.example.dk', expires: 0 }),
  ),
  row(
    'header',
    'www.example.dk',
    'HTTP/1.1 200 OK\r\ncontent-type: text/html\r\nx-frame-options: DENY\r\n(no strict-transport-security header)',
  ),
];
const output = {
  policies: { observation: { outcome: 'pass' } },
  formInventory: { forms: [{}, {}] },
} as never;

const snap = (
  over: Partial<CanarySnapshot> & {
    findings?: CanarySnapshot['derived'] extends infer D
      ? D extends { findings: infer F }
        ? F
        : never
      : never;
  },
): CanarySnapshot =>
  snapshotOf({
    host: 'www.example.dk',
    scannedAt: T0,
    commit: 'abc1234',
    families: ['security', 'recipients'],
    evidence,
    output,
    findings: over.findings ?? [
      { typeId: 'CNS-01', severity: 'serious' },
      { typeId: 'SEC-03', severity: 'serious' },
    ],
    ...(over.host ? { host: over.host } : {}),
  });

describe('the corpus', () => {
  it('is public sites with an owner, a pace and an exclusion list, and no host twice', () => {
    expect(activeSites(corpus).length).toBeGreaterThanOrEqual(60);
    expect(corpus.owner.contact).toMatch(/@/);
    expect(corpus.owner.role).toMatch(/triage/i);
    expect(corpus.politeness).toMatchObject({ maxConcurrent: 1, respectRobots: true });
    expect(corpus.politeness.minIntervalMs).toBeGreaterThanOrEqual(1000);
    for (const s of corpus.sites) {
      expect(s.host).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
      expect(['DK', 'DE', 'EU']).toContain(s.country);
    }
  });

  it('an exclusion takes a site out of the run and never out of the file', () => {
    const excluded = {
      ...corpus,
      exclusions: [{ host: corpus.sites[0]!.host, reason: 'asked', since: '2026-09-04' }],
    };
    expect(activeSites(excluded).map((s) => s.host)).not.toContain(corpus.sites[0]!.host);
    expect(activeSites(excluded)).toHaveLength(corpus.sites.length - 1);
    expect(excluded.sites).toHaveLength(corpus.sites.length);
    const twice = { ...corpus, sites: [...corpus.sites, corpus.sites[0]!] };
    expect(CanaryCorpusSchema.safeParse(twice).success).toBe(false);
    const impolite = { ...corpus, politeness: { ...corpus.politeness, respectRobots: false } };
    expect(CanaryCorpusSchema.safeParse(impolite).success).toBe(false);
  });
});

describe('a snapshot', () => {
  it('separates what was observed from what the scanner made of it', () => {
    const s = snap({});
    expect(s.raw).toEqual({
      thirdPartyHosts: ['fonts.gstatic.com', 'www.googletagmanager.com'],
      cookies: ['_ga', 'session'],
      headerNames: ['content-type', 'x-frame-options'],
      policyFound: true,
      forms: 2,
    });
    expect(s.derived?.findings.map((f) => f.typeId)).toEqual(['CNS-01', 'SEC-03']);
    expect(s.scanner).toEqual({ commit: 'abc1234', families: ['recipients', 'security'] });
    expect(
      rawSummaryOf('www.example.dk', [], { policies: undefined, formInventory: undefined }),
    ).toEqual({
      thirdPartyHosts: [],
      cookies: [],
      headerNames: [],
      policyFound: false,
      forms: 0,
    });
  });

  it('is written per site per night and read back by date', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-'));
    try {
      writeSnapshot(dir, '2026-09-03', snap({}));
      writeSnapshot(dir, '2026-09-04', snap({}));
      writeSnapshot(dir, '2026-09-04', snap({ host: 'www.beispiel.de' }));
      expect(snapshotDates(dir)).toEqual(['2026-09-03', '2026-09-04']);
      expect([...readSnapshots(dir, '2026-09-04').keys()]).toEqual([
        'www.beispiel.de',
        'www.example.dk',
      ]);
      expect(readSnapshots(dir, '2026-09-02').size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('day over day', () => {
  const base = snap({});
  it('the same observation and the same findings is nothing', () => {
    expect(compareSnapshots(base, snap({}))).toMatchObject({ change: 'none', alarm: false });
  });

  it('a site that changed, read the same way, is the site and no alarm', () => {
    const changed = {
      ...snap({}),
      raw: {
        ...base.raw!,
        thirdPartyHosts: [...base.raw!.thirdPartyHosts, 'www.facebook.com'],
        cookies: ['session'],
      },
    };
    const c = compareSnapshots(base, changed);
    expect(c.change).toBe('site-changed');
    expect(c.alarm).toBe(false);
    expect(c.details).toEqual([
      'third-party hosts added: www.facebook.com',
      'cookies removed: _ga',
    ]);
  });

  it('the same observation with different findings is the scanner, and the alarm', () => {
    const c = compareSnapshots(
      base,
      snap({ findings: [{ typeId: 'CNS-01', severity: 'serious' }] }),
    );
    expect(c.change).toBe('scanner-changed');
    expect(c.alarm).toBe(true);
    expect(c.details[0]).toContain('the same observation gave different findings');
    expect(c.details.join('\n')).toContain('SEC-03');
  });

  it('a site that changed on the night the build changed, with different findings, is both', () => {
    const other = {
      ...snap({ findings: [{ typeId: 'CNS-01', severity: 'serious' }] }),
      scanner: { commit: 'def5678', families: ['recipients', 'security'] },
    };
    const withRaw = { ...other, raw: { ...other.raw!, forms: 3 } };
    const c = compareSnapshots(base, withRaw);
    expect(c.change).toBe('both');
    expect(c.alarm).toBe(true);
    expect(c.details.at(-1)).toBe('build abc1234 → def5678');
    // The same on the same build is the site.
    const sameBuild = { ...withRaw, scanner: base.scanner };
    expect(compareSnapshots(base, sameBuild)).toMatchObject({
      change: 'site-changed',
      alarm: false,
    });
  });

  it('a first snapshot, a missing one and an unreachable site are named, not alarmed', () => {
    expect(compareSnapshots(undefined, base)).toMatchObject({ change: 'new', alarm: false });
    expect(compareSnapshots(base, undefined)).toMatchObject({ change: 'gone', alarm: false });
    const down: CanarySnapshot = {
      host: base.host,
      scannedAt: T0,
      scanner: base.scanner,
      status: 'unreachable',
      reason: 'timeout',
    };
    expect(compareSnapshots(base, down)).toMatchObject({
      change: 'unreachable',
      alarm: false,
      details: ['unreachable: timeout'],
    });
  });
});

describe('the report', () => {
  const two = { ...corpus, sites: corpus.sites.slice(0, 10), exclusions: [] };
  const night = (make: (host: string, i: number) => CanarySnapshot) =>
    new Map(two.sites.map((s, i) => [s.host, make(s.host, i)] as const));
  const dir = mkdtempSync(join(tmpdir(), 'canary-report-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('counts every site, names the owner, and is quiet when only sites changed', () => {
    const before = night((host) => snap({ host }));
    const after = night((host, i) =>
      i === 0
        ? { ...snap({ host }), raw: { ...snap({ host }).raw!, cookies: [] } }
        : snap({ host }),
    );
    const r = canaryReport(
      two,
      { date: '2026-09-03', snapshots: before },
      { date: '2026-09-04', snapshots: after },
    );
    expect(r.counts).toMatchObject({ none: 9, 'site-changed': 1, 'scanner-changed': 0 });
    expect(r.alarm).toBe(false);
    expect(r.owner.name).toBe(corpus.owner.name);
    const text = formatCanaryReport(r);
    expect(text).toContain('9 unchanged, 1 site changed');
    expect(text).toContain('no alarm');
  });

  it('one scanner change is an alarm with the owner and the triage page on it', () => {
    const before = night((host) => snap({ host }));
    const after = night((host, i) => (i === 3 ? snap({ host, findings: [] }) : snap({ host })));
    const r = canaryReport(
      two,
      { date: '2026-09-03', snapshots: before },
      { date: '2026-09-04', snapshots: after },
    );
    expect(r.alarm).toBe(true);
    expect(r.why).toEqual([`${two.sites[3]!.host}: scanner-changed`]);
    const text = formatCanaryReport(r);
    expect(text).toContain(`ALARM for ${corpus.owner.name} <${corpus.owner.contact}>`);
    expect(text).toContain('docs/canary.md');
  });

  it('a fleet-wide shift in findings is the scanner even when every raw summary moved', () => {
    const before = night((host) => snap({ host }));
    const after = night((host, i) =>
      i < 4
        ? { ...snap({ host, findings: [] }), raw: { ...snap({ host }).raw!, forms: 9 } }
        : snap({ host }),
    );
    const r = canaryReport(
      two,
      { date: '2026-09-03', snapshots: before },
      { date: '2026-09-04', snapshots: after },
    );
    expect(r.fleetShift).toEqual({ changed: 4, scanned: 10, share: 0.4 });
    expect(r.fleetShift.share).toBeGreaterThanOrEqual(FLEET_SHIFT_SHARE);
    expect(r.alarm).toBe(true);
    expect(r.why.join(' ')).toContain('the scanner moved');
  });

  it('more unreachable than scanned is the runner, and says so', () => {
    const before = night((host) => snap({ host }));
    const after = night((host, i) =>
      i < 7
        ? {
            host,
            scannedAt: T0,
            scanner: snap({}).scanner,
            status: 'unreachable' as const,
            reason: 'no route',
          }
        : snap({ host }),
    );
    const r = canaryReport(
      two,
      { date: '2026-09-03', snapshots: before },
      { date: '2026-09-04', snapshots: after },
    );
    expect(r.counts.unreachable).toBe(7);
    expect(r.alarm).toBe(true);
    expect(r.why.join(' ')).toContain('the runner, not the sites');
  });
});
