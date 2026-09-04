import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvidenceSchema, FindingSchema, PassCaptureSchema, sha256 } from '@gc/contracts';
import {
  BrowserPool,
  DEFAULT_QUIET,
  FixtureServer,
  captureToEvidence,
  collectPassA,
  loadFixtureSites,
  refTo,
} from '@gc/scanner';
import { loadCatalogue } from '@gc/remedies';

// The remedy's current catalogue version: what the seed writes and a finding references.
const remedyVersion = (id: string): number => {
  const entry = loadCatalogue().get(id);
  if (!entry) throw new Error(`no remedy ${id}`);
  return entry.remedy.version;
};

// Pass A against the fixture estate: what it captures, how it waits, and how a capture
// becomes evidence a finding can point at by hash.

const sites = loadFixtureSites();
let server: FixtureServer;
let pool: BrowserPool;

beforeAll(async () => {
  server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
  pool = await new BrowserPool({
    concurrency: 2,
    passTimeoutMs: 30_000,
    navigationTimeoutMs: 10_000,
    launch: { proxy: { server: server.proxy } },
    ignoreHTTPSErrors: true,
  }).start();
});

afterAll(async () => {
  await pool?.stop();
  await server?.stop();
});

describe('what Pass A captures (S-02)', () => {
  it('every request, with its initiator chain, timing and resource type', async () => {
    const { capture } = await collectPassA(pool, { url: 'http://eksempelbutik.test/' });
    expect(PassCaptureSchema.safeParse(capture).success).toBe(true);
    expect(capture.pass).toBe('A');
    expect(capture.status).toBe(200);

    const byUrl = new Map(capture.requests.map((r) => [r.url, r]));
    const doc = byUrl.get('http://eksempelbutik.test/');
    expect(doc?.resourceType).toBe('document');
    expect(doc?.chain).toEqual([]);

    const tag = byUrl.get('http://analytics.tracker.test/tag.js');
    expect(tag?.resourceType).toBe('script');
    expect(tag?.initiator.type).toBe('parser');
    expect(tag?.initiator.url).toBe('http://eksempelbutik.test/');
    expect(tag?.initiator.line).toBeGreaterThanOrEqual(1);
    expect(tag?.status).toBe(200);
    expect(tag?.startedAtMs).toBeGreaterThanOrEqual(0);
    expect(tag?.durationMs).toBeGreaterThanOrEqual(0);

    // The pixel was requested by the tag's script while the parser waited on it, which
    // Chromium attributes to the document at the script tag's line. A script-injected
    // request (see the lazy fixture) carries the script's URL instead.
    const collect = capture.requests.find((r) =>
      r.url.startsWith('http://analytics.tracker.test/collect'),
    );
    expect(collect?.resourceType).toBe('image');
    expect(collect?.initiator.type).toBe('parser');
    expect(collect?.initiator.url).toBe('http://eksempelbutik.test/');
    expect(collect?.initiator.line).toBe(tag?.initiator.line);
    expect(collect?.chain).toEqual(['http://eksempelbutik.test/']);
    const pixel = byUrl.get('http://pixel.social.test/px.svg');
    expect(pixel?.initiator.line).toBeGreaterThan(tag!.initiator.line!);
    expect(collect?.status).toBe(204);

    for (const r of capture.requests) {
      expect(r.frameUrl).toBe('http://eksempelbutik.test/');
      expect(r.failed).toBeUndefined();
    }
  });

  it('every cookie with domain, expiry, secure, httpOnly and sameSite', async () => {
    const { capture } = await collectPassA(pool, { url: 'http://eksempelbutik.test/' });
    const trk = capture.cookies.find((c) => c.name === '_trk');
    expect(trk).toMatchObject({
      domain: 'eksempelbutik.test',
      path: '/',
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    });
    expect(trk!.expires).toBeGreaterThan(Date.now() / 1000 + 60 * 60 * 24 * 365);
    expect(trk!.value.length).toBeGreaterThan(3);
    // Nothing was clicked, so the consent platform recorded nothing.
    expect(capture.cookies.map((c) => c.name)).not.toContain('cmp_consent');
  });

  it('every write to web storage, with when it happened', async () => {
    const { capture } = await collectPassA(pool, { url: 'http://lazyshop.test/' });
    expect(capture.storage).toHaveLength(1);
    expect(capture.storage[0]).toMatchObject({
      origin: 'http://lazyshop.test',
      area: 'local',
      key: 'lazyshop_visitor',
    });
    expect(capture.storage[0]!.value).toMatch(/^v-/);
    expect(capture.storage[0]!.atMs).toBeGreaterThanOrEqual(0);
  });

  it('a full-page screenshot, hashed', async () => {
    const { capture, screenshot } = await collectPassA(pool, { url: 'http://brochure.test/' });
    expect(screenshot.length).toBeGreaterThan(1_000);
    expect(Buffer.from(screenshot.slice(0, 8)).toString('hex')).toBe('89504e470d0a1a0a');
    expect(capture.screenshotHash).toBe(sha256(Buffer.from(screenshot).toString('base64')));
  });
});

describe('network quiet (S-02)', () => {
  it('waits long enough to see a tracker that arrives four seconds after load', async () => {
    const { capture } = await collectPassA(pool, { url: 'http://lazyshop.test/' });
    const hosts = new Set(capture.requests.map((r) => r.host));
    expect(hosts).toContain('lazy.tracker.test');
    const tag = capture.requests.find((r) => r.url === 'http://lazy.tracker.test/tag.js');
    expect(tag?.startedAtMs).toBeGreaterThanOrEqual(3_500);
    expect(tag?.initiator.type).toBe('script');
    expect(tag?.initiator.url).toBe('http://lazyshop.test/');
    expect(tag?.chain).toEqual(['http://lazyshop.test/']);
    expect(capture.quiet).toMatchObject({ ...DEFAULT_QUIET, settled: true });
    expect(capture.quiet.dwellMs).toBeGreaterThanOrEqual(DEFAULT_QUIET.minDwellMs);
    expect(capture.quiet.lastRequestAtMs).toBeGreaterThanOrEqual(3_500);
  });

  it('half a second of network idle, the usual shortcut, misses it', async () => {
    const browser = await chromium.launch({ proxy: { server: server.proxy } });
    try {
      const page = await browser.newPage();
      const hosts = new Set<string>();
      page.on('request', (r) => hosts.add(new URL(r.url()).hostname));
      await page.goto('http://lazyshop.test/', { waitUntil: 'networkidle' });
      expect(hosts).not.toContain('lazy.tracker.test');
    } finally {
      await browser.close();
    }
  });

  it('the floor is configurable and the cap ends a page that never goes quiet', async () => {
    const quick = await collectPassA(
      pool,
      { url: 'http://brochure.test/' },
      { quiet: { minDwellMs: 500 } },
    );
    expect(quick.capture.quiet.settled).toBe(true);
    expect(quick.capture.quiet.dwellMs).toBeLessThan(DEFAULT_QUIET.minDwellMs);

    const capped = await collectPassA(
      pool,
      { url: 'http://lazyshop.test/' },
      { quiet: { minDwellMs: 500, quietMs: 60_000, maxWaitMs: 2_000 } },
    );
    expect(capped.capture.quiet.settled).toBe(false);
    expect(capped.capture.quiet.dwellMs).toBeGreaterThanOrEqual(2_000);
    expect(capped.capture.quiet.dwellMs).toBeLessThan(3_500);
  });
});

describe('evidence is content-addressed (S-02)', () => {
  const identity = {
    tenantId: 't-1',
    caseId: 'DK-26-0M4K',
    scanId: 'scan-1',
    capturedAt: '2026-09-03T09:14:00Z',
  };

  it('every row is valid, its hash is the hash of its body, and the same capture gives the same rows', async () => {
    const { capture, screenshot } = await collectPassA(pool, { url: 'http://eksempelbutik.test/' });
    const rows = captureToEvidence(capture, screenshot, identity);
    expect(rows.length).toBe(
      capture.requests.length + capture.cookies.length + capture.storage.length + 2,
    );
    for (const row of rows) {
      expect(EvidenceSchema.safeParse(row).success).toBe(true);
      expect(row.hash).toBe(sha256(row.body));
      expect(row.id).toBe(`${row.kind}:${row.hash.slice(0, 16)}`);
    }
    expect(captureToEvidence(capture, screenshot, identity)).toEqual(rows);

    const kinds = new Set(rows.map((r) => r.kind));
    expect([...kinds].sort()).toEqual(['cookie', 'http_request', 'screenshot', 'text']);
    const shot = rows.find((r) => r.kind === 'screenshot')!;
    expect(shot.hash).toBe(capture.screenshotHash);
    expect(Buffer.from(shot.body, 'base64')).toEqual(Buffer.from(screenshot));
    const summary = rows.find((r) => r.kind === 'text')!;
    expect(summary.body.split('\n')).toEqual(
      expect.arrayContaining(['analytics.tracker.test', 'consent.cmp.test', 'pixel.social.test']),
    );
  });

  it('a finding references evidence by hash, and a quote is checked against the body', async () => {
    const { capture, screenshot } = await collectPassA(pool, { url: 'http://eksempelbutik.test/' });
    const rows = captureToEvidence(capture, screenshot, identity);
    const summary = rows.find((r) => r.kind === 'text')!;
    const ref = refTo(summary, 'analytics.tracker.test');
    expect(summary.body).toContain(ref.quote!);
    const finding = FindingSchema.safeParse({
      id: 'f-1',
      tenantId: identity.tenantId,
      caseId: identity.caseId,
      scanId: identity.scanId,
      typeId: 'CNS-01',
      fingerprint: 'CNS-01|eksempelbutik.test||',
      jurisdiction: 'DK',
      binding: {
        findingTypeId: 'CNS-01',
        jurisdiction: 'DK',
        citations: [
          {
            kind: 'provision',
            instrument: 'ePrivacy',
            article: '5',
            paragraph: '3',
            ref: 'Art. 5(3)',
          },
        ],
        authority: { name: 'Datatilsynet' },
        guideId: 'cns-01',
        version: 1,
      },
      severity: 'blocking',
      status: 'open',
      area: 'Consent',
      evidence: [ref],
      remedy: { remedyId: 'cns-02-gate-tags', version: remedyVersion('cns-02-gate-tags') },
      firstSeenAt: identity.capturedAt,
      lastSeenAt: identity.capturedAt,
    });
    expect(finding.success).toBe(true);
  });
});
