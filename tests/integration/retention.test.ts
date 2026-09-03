import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@gc/contracts';
import {
  RETENTION,
  RETENTION_JOB,
  UNCLAIMED_CASE_TTL_DAYS,
  UNCLAIMED_PURGE_GRACE_DAYS,
  caseByToken,
  confirmClaim,
  createTestDatabase,
  openCase,
  registerRetentionWorker,
  requestClaim,
  runRetention,
  schema,
  testDatabaseUrl,
  textSurvivesAnywhere,
  withTenant,
  type RetentionRun,
  type TestDatabase,
} from '@gc/db';
import { JobQueue } from '@gc/jobs';
import { eq } from 'drizzle-orm';
import { tablesInSnapshot } from '../../scripts/rls-check.mjs';

// Retention (O-02): every table declares its lifetime, an unclaimed case and all its
// evidence expire and are purged on the clock, and the sweep runs as a job.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const T0 = new Date('2026-09-03T09:14:00Z');
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);

describe.skipIf(!url)('retention (O-02)', () => {
  let t: TestDatabase;
  let unclaimed = { caseId: '', tenantId: '', token: '' };
  let claimed = { caseId: '', tenantId: '', token: '' };
  const body = `secret page text ${randomBytes(8).toString('hex')}`;
  const hash = sha256(body);

  beforeAll(async () => {
    t = await createTestDatabase(url);
    for (const which of ['unclaimed', 'claimed'] as const) {
      const opened = await openCase(t, {
        company: { domain: `${which}.dk`, country: 'DK', locale: 'da' },
        jurisdiction: 'DK',
        locale: 'da',
        now: () => T0,
      });
      const ref = { caseId: opened.caseId, tenantId: opened.tenantId, token: opened.accessToken };
      if (which === 'unclaimed') unclaimed = ref;
      else claimed = ref;
      await withTenant(t, opened.tenantId, (db) =>
        db.insert(schema.evidence).values({
          id: `text:${sha256(`${body}:${which}`).slice(0, 16)}`,
          tenantId: opened.tenantId,
          sourceRef: 'test',
          caseId: opened.caseId,
          kind: 'text',
          capturedAt: T0,
          body: `${body}:${which}`,
          hash: sha256(`${body}:${which}`),
        }),
      );
    }
    const challenge = await requestClaim(t, { ...claimed, email: 'a@claimed.dk', now: () => T0 });
    await confirmClaim(t, { ...claimed, code: challenge.code, now: () => T0 });
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('every table in the schema declares a retention rule, and no rule names a missing table', () => {
    const tables = tablesInSnapshot().sort();
    expect(Object.keys(RETENTION).sort()).toEqual(tables);
    expect(RETENTION['cases']).toEqual({
      kind: 'case',
      unclaimedDays: UNCLAIMED_CASE_TTL_DAYS,
      graceDays: UNCLAIMED_PURGE_GRACE_DAYS,
    });
    expect(RETENTION['evidence']).toEqual({ kind: 'with_case' });
    expect(RETENTION['deletion_audit']).toEqual({ kind: 'anonymous_forever' });
  });

  it('before expiry the sweep touches nothing', async () => {
    const run = await runRetention(t, days(10));
    expect(run).toMatchObject({
      expired: [],
      purged: [],
      claimsRemoved: 0,
      demandEntriesRemoved: 0,
    });
    expect(await caseByToken(t, unclaimed.token)).toBeDefined();
  });

  it('at expiry the unclaimed case gets its closing event and its token stops; after grace it is purged with its evidence', async () => {
    // Expiry is the database's clock: the token stops the moment expires_at passes.
    await t.sql`update cases set expires_at = now() - interval '1 day' where id = ${unclaimed.caseId}`;
    const atExpiry = await runRetention(t, new Date());
    expect(atExpiry.expired).toEqual([unclaimed.caseId]);
    expect(atExpiry.purged).toEqual([]);
    expect(await caseByToken(t, unclaimed.token)).toBeUndefined();
    expect(await textSurvivesAnywhere(t, `${body}:unclaimed`)).toEqual(['evidence']);

    await t.sql`update cases set expires_at = now() - interval '8 days' where id = ${unclaimed.caseId}`;
    const afterGrace = await runRetention(t, new Date());
    expect(afterGrace.purged).toHaveLength(1);
    expect(afterGrace.purged[0]?.rowsRemoved).toBeGreaterThanOrEqual(3);
    expect(afterGrace.durationMs).toBeLessThan(30_000);

    // Not the evidence body, not its hash, not the case number: nowhere in the schema.
    for (const needle of [
      `${body}:unclaimed`,
      sha256(`${body}:unclaimed`),
      unclaimed.caseId,
      unclaimed.tenantId,
    ]) {
      expect(await textSurvivesAnywhere(t, needle), needle).toEqual([]);
    }
    const audit = await t.db.select().from(schema.deletionAudit);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.requestedBy).toBe('retention');

    // The claimed case, and its evidence, are untouched.
    expect(await caseByToken(t, claimed.token)).toMatchObject({ claimed: true });
    expect(await textSurvivesAnywhere(t, `${body}:claimed`)).toEqual(['evidence']);
    expect(hash).toHaveLength(64);
  });

  it('used claims are purged after their tail; the sweep is idempotent', async () => {
    const claims = () =>
      t.db.select().from(schema.caseClaims).where(eq(schema.caseClaims.caseId, claimed.caseId));
    expect((await claims()).length).toBe(1);
    const run = await runRetention(t, days(400));
    expect(run.claimsRemoved).toBe(1);
    expect(run.purged).toEqual([]);
    expect((await claims()).length).toBe(0);
    expect(await runRetention(t, days(401))).toMatchObject({
      expired: [],
      purged: [],
      claimsRemoved: 0,
    });
  });

  it('runs as a job on the queue, with the clock it is given', async () => {
    const queue = new JobQueue({
      connectionString: url!,
      schema: `pgboss_${randomBytes(4).toString('hex')}`,
      pollingIntervalSeconds: 0.5,
    });
    await queue.start();
    try {
      const runs: RetentionRun[] = [];
      await registerRetentionWorker(queue, t, (run) => runs.push(run));
      const id = await queue.enqueue(RETENTION_JOB, { now: days(402).toISOString() });
      const deadline = Date.now() + 15_000;
      while (runs.length === 0 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 200));
      expect(runs).toHaveLength(1);
      expect(runs[0]?.at).toBe(days(402).toISOString());
      expect((await queue.status(RETENTION_JOB, id))?.state).toBe('completed');
      await expect(queue.enqueue(RETENTION_JOB, { now: 'yesterday' } as never)).rejects.toThrow(
        /payload rejected/,
      );
    } finally {
      await queue.drop();
      await queue.stop({ graceful: false });
    }
  });
});
