import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Finding } from '@gc/contracts';
import {
  WATCH_CRON,
  WATCH_JOB,
  attestFinding,
  caseTimeline,
  createTestDatabase,
  findingsForCase,
  openCase,
  recordScan,
  reverifyFinding,
  runWatch,
  seedRemedies,
  storeFindings,
  testDatabaseUrl,
  verificationFor,
  withTenant,
  type CheckRun,
  type CheckRunner,
  type TestDatabase,
} from '@gc/db';
import { assembleFindings, bindingFor } from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';
import { BrowserPool, FixtureServer, loadFixtureSites, runChecks } from '@gc/scanner';

// The re-scan and fix verification loop (C-05): a full scan is recorded against the
// case; re-checking one finding re-runs only its family and reconciles only that family,
// at a fraction of the cost; a fix closes it with the date on the timeline, and a
// regression reopens it with the second date next to the first; a remedy verified by
// attestation is not re-scanned but closed by a person's word; the weekly watch runs
// everything and raises only what changed.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const T0 = new Date('2026-09-04T09:14:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const catalogue = loadCatalogue();
const sites = loadFixtureSites();
const target = { url: 'https://usikker.test/' };
const quiet = { minDwellMs: 800, quietMs: 400, maxWaitMs: 8_000 };
const mette = { kind: 'person' as const, userId: 'u-mette', name: 'Mette Hansen' };
let server: FixtureServer;
let pool: BrowserPool;
let db: TestDatabase;
let tenantId: string;
let caseId: string;

beforeAll(async () => {
  server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
  pool = await new BrowserPool({
    concurrency: 3,
    passTimeoutMs: 60_000,
    navigationTimeoutMs: 10_000,
    launch: { proxy: { server: server.proxy } },
    ignoreHTTPSErrors: true,
  }).start();
  if (!url) return;
  db = await createTestDatabase(url);
  await seedRemedies(db, catalogue);
  const opened = await openCase(db, {
    company: { domain: 'usikker.test', country: 'DK', locale: 'da' },
    jurisdiction: 'DK',
    locale: 'da',
    now: () => T0,
  });
  tenantId = opened.tenantId;
  caseId = opened.caseId;
});

afterAll(async () => {
  await pool?.stop();
  await server?.stop();
  await db?.drop();
});

// The scanner, as the loop sees it. `without` simulates a fix by dropping a check's
// failure from what came back.
const runner =
  (without?: string): CheckRunner =>
  async (families) => {
    const out = await runChecks(pool, target, {
      identity: { tenantId, caseId, scanId: 'scan', capturedAt: T0.toISOString() },
      families: families.filter((f) => f !== 'ct') as (
        'security' | 'forms' | 'replay' | 'policies' | 'consent'
      )[],
      quiet,
      now: () => T0,
    });
    const security = out.security?.filter((o) => o.findingTypeId !== without);
    const run: CheckRun = {
      families,
      input: {
        ...(security ? { security } : {}),
        ...(out.forms ? { forms: out.forms } : {}),
        ...(out.replay ? { replay: out.replay } : {}),
        ...(out.policies ? { policies: out.policies } : {}),
        ...(out.consent ? { consent: out.consent } : {}),
      },
      evidence: out.evidence,
      checksRun: out.checksRun,
      checksPassed: out.checksPassed,
      undetermined: out.undetermined,
      durationMs: out.durationMs,
    };
    return run;
  };

const ctx = (now: Date, previous?: Map<string, Finding['status']>) => ({
  tenantId,
  caseId,
  jurisdiction: 'DK' as const,
  catalogue,
  host: 'usikker.test',
  scanId: `scan-${now.getTime()}`,
  now: () => now,
  ...(previous ? { previous } : {}),
});

let fullDurationMs = 0;
let hstsId = '';

describe.skipIf(!url)('the loop', () => {
  it('records the first scan: findings raised, each on the timeline with the scan around them', async () => {
    const run = await runner()(['security', 'forms', 'replay', 'policies', 'consent']);
    fullDurationMs = run.durationMs;
    const assembled = assembleFindings(run.input, ctx(T0));
    const record = await recordScan(db, tenantId, caseId, {
      scanId: 'scan-1',
      kind: 'initial',
      findings: assembled.findings,
      evidence: run.evidence,
      checksRun: run.checksRun,
      checksPassed: run.checksPassed,
      undetermined: run.undetermined,
      actor: { kind: 'scanner' },
      now: T0,
    });
    expect(record.opened.length).toBeGreaterThanOrEqual(8);
    expect(record.changes).toBe(record.opened.length);
    const timeline = await withTenant(db, tenantId, (tx) => caseTimeline(tx, caseId));
    const types = timeline.map((e) => e.type);
    expect(types[0]).toBe('case_opened');
    expect(types[1]).toBe('scan_started');
    expect(types.at(-1)).toBe('scan_completed');
    expect(types.filter((t) => t === 'finding_raised')).toHaveLength(record.opened.length);
    hstsId = (await findingsForCase(db, tenantId, caseId)).find((r) => r.typeId === 'SEC-03')!.id;
  });

  it('re-checks one finding by re-running its family alone, and closes it when the fix took', async () => {
    const run = vi.fn(runner('SEC-03'));
    const outcome = await reverifyFinding(db, tenantId, hstsId, {
      catalogue,
      run,
      actor: mette,
      host: 'usikker.test',
      now: () => at(60),
      scanId: 'recheck-1',
    });
    expect(outcome.method).toBe('rescan');
    if (outcome.method !== 'rescan') return;
    expect(outcome.family).toBe('security');
    expect(run).toHaveBeenCalledWith(['security']);
    expect(outcome.closed).toBe(true);
    expect(outcome.record.closed).toEqual([hstsId]);
    // A fraction of the full scan: one family instead of five, and well under the time.
    expect(outcome.durationMs).toBeLessThan(fullDurationMs);
    console.log(`full scan ${fullDurationMs} ms, re-check ${outcome.durationMs} ms`);

    const rows = await findingsForCase(db, tenantId, caseId);
    expect(rows.find((r) => r.id === hstsId)?.status).toBe('closed');
    // What the re-check did not look at is untouched.
    expect(rows.find((r) => r.typeId === 'FRM-03')?.status).toBe('open');
    expect(rows.filter((r) => r.status === 'closed')).toHaveLength(1);
    const timeline = await withTenant(db, tenantId, (tx) => caseTimeline(tx, caseId));
    const closed = timeline.find((e) => e.type === 'finding_closed')!;
    expect(closed.payload).toEqual({ findingId: hstsId, verifiedBy: 'rescan' });
    expect(closed.actor).toEqual(mette);
    expect(timeline.filter((e) => e.type === 'scan_started').at(-1)?.payload).toMatchObject({
      kind: 'recheck',
    });
  });

  it('a closed finding that regresses reopens with both dates on the timeline, one level up', async () => {
    const outcome = await reverifyFinding(db, tenantId, hstsId, {
      catalogue,
      run: runner(),
      actor: { kind: 'scanner' },
      host: 'usikker.test',
      now: () => at(120),
      scanId: 'recheck-2',
    });
    expect(outcome.method).toBe('rescan');
    if (outcome.method !== 'rescan') return;
    expect(outcome.closed).toBe(false);
    expect(outcome.record.regressed).toEqual([hstsId]);
    const row = (await findingsForCase(db, tenantId, caseId)).find((r) => r.id === hstsId)!;
    expect(row.status).toBe('regressed');
    expect(row.closedAt).toBeNull();
    expect(row.severity).toBe('blocking');
    const timeline = await withTenant(db, tenantId, (tx) => caseTimeline(tx, caseId));
    const closed = timeline.find((e) => e.type === 'finding_closed')!;
    const regressed = timeline.find((e) => e.type === 'finding_regressed')!;
    expect(regressed.payload).toEqual({ findingId: hstsId });
    expect(new Date(regressed.at).getTime()).toBeGreaterThan(new Date(closed.at).getTime());
    expect(closed.at.slice(0, 16)).toBe(at(60).toISOString().slice(0, 16));
    expect(regressed.at.slice(0, 16)).toBe(at(120).toISOString().slice(0, 16));
  });

  it('a remedy verified by attestation is not re-scanned; a person closes it', async () => {
    const binding = bindingFor('AI-03', 'DK');
    const remedy = catalogue.forFinding('AI-03', 'DK')[0]!;
    const finding: Finding = {
      id: 'f-ai03',
      tenantId,
      caseId,
      typeId: 'AI-03',
      fingerprint: 'AI-03|||',
      jurisdiction: 'DK',
      binding,
      severity: 'serious',
      status: 'open',
      area: 'Transfers',
      evidence: [{ evidenceId: 'answer:0000000000000000', hash: 'a'.repeat(64) }],
      remedy: { remedyId: remedy.remedy.id, version: remedy.remedy.version },
      firstSeenAt: T0.toISOString(),
      lastSeenAt: T0.toISOString(),
    };
    // Stored without a join row: the pointer names an answer the case does not hold yet.
    await storeFindings(db, tenantId, [{ ...finding, evidence: [] } as Finding]);
    expect(verificationFor(finding, catalogue)?.method).toBe('attestation');
    const run = vi.fn(runner());
    const outcome = await reverifyFinding(db, tenantId, 'f-ai03', {
      catalogue,
      run,
      actor: mette,
      host: 'usikker.test',
    });
    expect(outcome.method).toBe('attestation');
    expect(run).not.toHaveBeenCalled();
    await attestFinding(db, tenantId, 'f-ai03', {
      by: mette,
      statement: 'The people named have stopped using the previous assistant.',
      now: at(200),
    });
    const row = (await findingsForCase(db, tenantId, caseId)).find((r) => r.id === 'f-ai03')!;
    expect(row.status).toBe('closed');
    const timeline = await withTenant(db, tenantId, (tx) => caseTimeline(tx, caseId));
    const attested = timeline.filter(
      (e) => e.type === 'finding_closed' && e.payload.findingId === 'f-ai03',
    );
    expect(attested).toHaveLength(1);
    expect(attested[0]!.payload).toMatchObject({ verifiedBy: 'attestation' });
    expect(attested[0]!.actor).toEqual(mette);
  });

  it('the weekly watch runs everything and raises only genuine changes', async () => {
    expect(WATCH_JOB.name).toBe('watch-case');
    expect(WATCH_CRON).toBe('30 4 * * 1');
    const before = (await withTenant(db, tenantId, (tx) => caseTimeline(tx, caseId))).length;
    const quietWeek = await runWatch(db, tenantId, caseId, {
      catalogue,
      run: runner(),
      host: 'usikker.test',
      now: () => at(7 * 86_400),
    });
    expect(quietWeek.changes).toBe(0);
    const timeline = await withTenant(db, tenantId, (tx) => caseTimeline(tx, caseId));
    const added = timeline.slice(before).map((e) => e.type);
    expect(added).toEqual(['scan_started', 'scan_completed', 'watch_run']);
    expect(timeline.at(-1)!.payload).toEqual({ scanId: quietWeek.scanId, changes: 0 });
    expect(timeline.at(-1)!.actor).toEqual({ kind: 'watcher' });

    const fixedWeek = await runWatch(db, tenantId, caseId, {
      catalogue,
      run: runner('SEC-03'),
      host: 'usikker.test',
      now: () => at(14 * 86_400),
    });
    expect(fixedWeek.changes).toBe(1);
    expect(fixedWeek.record.closed).toEqual([hstsId]);
    const after = await withTenant(db, tenantId, (tx) => caseTimeline(tx, caseId));
    expect(after.at(-1)!.payload).toEqual({ scanId: fixedWeek.scanId, changes: 1 });
    expect(after.filter((e) => e.type === 'watch_run')).toHaveLength(2);
  });
});
