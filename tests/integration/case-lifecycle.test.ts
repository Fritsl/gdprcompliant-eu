import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CASE_NUMBER_PATTERN } from '@gc/contracts';
import {
  ClaimRefused,
  UNCLAIMED_CASE_TTL_DAYS,
  caseByToken,
  claimByOverride,
  confirmClaim,
  createTestDatabase,
  expireUnclaimedCases,
  openCase,
  requestClaim,
  schema,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { eq } from 'drizzle-orm';

// The case lifecycle (C-01): a number a person can read out, a token as the only door
// until the case is claimed, proof of an address at the scanned domain or a named
// override, expiry when nobody claims, and one case per domain per owner.

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
const at = (days: number) => () => new Date(T0.getTime() + days * 86_400_000);
const company = { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' } as const;
const open = (t: TestDatabase, extra: Partial<Parameters<typeof openCase>[1]> = {}) =>
  openCase(t, { company, jurisdiction: 'DK', locale: 'da', now: at(0), ...extra });

describe.skipIf(!url)('case lifecycle (C-01)', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase(url);
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('opens with a readable number, its own tenant, a token and an expiry, and one event', async () => {
    const opened = await open(t);
    expect(opened.caseId).toMatch(CASE_NUMBER_PATTERN);
    expect(opened.caseId.startsWith('DK-26-')).toBe(true);
    expect(opened.tenantId).toMatch(/^t-[0-9a-f]{18}$/);
    expect(opened.accessToken).toMatch(/^[0-9a-f]{64}$/);
    expect(opened.expiresAt?.toISOString()).toBe(at(UNCLAIMED_CASE_TTL_DAYS)().toISOString());
    expect(opened.continued).toBe(false);

    const events = await withTenant(t, opened.tenantId, (db) =>
      db.select().from(schema.caseEvents).where(eq(schema.caseEvents.caseId, opened.caseId)),
    );
    expect(events.map((e) => [e.seq, e.type, e.payload])).toEqual([
      [1, 'case_opened', { source: 'scanner' }],
    ]);
  });

  it('a number collision is retried, never reused', async () => {
    let calls = 0;
    // The same four characters for the first two numbers, then a different one.
    const random = (max: number) => {
      const n = Math.floor(calls / 4);
      calls += 1;
      return n < 2 ? 7 % max : (calls * 7) % max;
    };
    const a = await open(t, { random, company: { ...company, domain: 'a.dk' } });
    const b = await open(t, { random, company: { ...company, domain: 'b.dk' } });
    expect(a.caseId).toBe('DK-26-9999');
    expect(b.caseId).not.toBe(a.caseId);
    expect(b.caseId).toMatch(CASE_NUMBER_PATTERN);
    const both = await t.db.select({ id: schema.cases.id }).from(schema.cases);
    expect(both.map((c) => c.id)).toEqual(expect.arrayContaining([a.caseId, b.caseId]));
  });

  it('an unclaimed case is reachable by its token alone, and not once it has expired', async () => {
    const opened = await open(t, { company: { ...company, domain: 'token.dk' } });
    expect(await caseByToken(t, opened.accessToken)).toEqual({
      caseId: opened.caseId,
      tenantId: opened.tenantId,
      claimed: false,
      expiresAt: opened.expiresAt,
    });
    expect(await caseByToken(t, 'f'.repeat(64))).toBeUndefined();
    expect(await caseByToken(t, opened.caseId)).toBeUndefined();
    expect(await caseByToken(t, `${opened.accessToken}' or 1=1 --`)).toBeUndefined();

    // Thirty-one days later, nobody claimed it.
    await t.sql`update cases set expires_at = ${at(-1)().toISOString()} where id = ${opened.caseId}`;
    expect(await caseByToken(t, opened.accessToken)).toBeUndefined();
    expect(await expireUnclaimedCases(t, at(31)())).toContain(opened.caseId);
    expect(await expireUnclaimedCases(t, at(32)())).toEqual([]);
    const events = await withTenant(t, opened.tenantId, (db) =>
      db.select().from(schema.caseEvents).where(eq(schema.caseEvents.caseId, opened.caseId)),
    );
    expect(events.at(-1)).toMatchObject({ type: 'case_expired', payload: { unclaimedFor: 31 } });
  });

  it('claiming needs an address at the scanned domain, the right code, once', async () => {
    const opened = await open(t, { company: { ...company, domain: 'claim.dk' } });
    const ctx = { caseId: opened.caseId, tenantId: opened.tenantId };

    await expect(requestClaim(t, { ...ctx, email: 'mette@gmail.com', now: at(1) })).rejects.toThrow(
      ClaimRefused,
    );
    await expect(
      requestClaim(t, { ...ctx, email: 'mette@claim.dk.evil.test', now: at(1) }),
    ).rejects.toMatchObject({ reason: 'wrong_domain' });

    const challenge = await requestClaim(t, { ...ctx, email: 'Mette@mail.claim.dk', now: at(1) });
    expect(challenge.code).toMatch(/^[0-9a-f]{32}$/);
    expect(challenge.expiresAt.toISOString()).toBe('2026-09-05T09:14:00.000Z');
    const stored = await withTenant(t, opened.tenantId, (db) =>
      db.select().from(schema.caseClaims),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.email).toBe('mette@mail.claim.dk');
    expect(stored[0]?.codeHash).not.toContain(challenge.code);

    await expect(confirmClaim(t, { ...ctx, code: 'deadbeef', now: at(1) })).rejects.toMatchObject({
      reason: 'bad_code',
    });
    expect(await caseByToken(t, opened.accessToken)).toMatchObject({ claimed: false });

    expect(await confirmClaim(t, { ...ctx, code: challenge.code, now: at(1) })).toEqual({
      email: 'mette@mail.claim.dk',
    });
    expect(await caseByToken(t, opened.accessToken)).toMatchObject({
      claimed: true,
      expiresAt: null,
    });
    await expect(
      confirmClaim(t, { ...ctx, code: challenge.code, now: at(1) }),
    ).rejects.toMatchObject({
      reason: 'bad_code',
    });
    await expect(
      requestClaim(t, { ...ctx, email: 'x@claim.dk', now: at(2) }),
    ).rejects.toMatchObject({
      reason: 'already_claimed',
    });

    const events = await withTenant(t, opened.tenantId, (db) =>
      db.select().from(schema.caseEvents).where(eq(schema.caseEvents.caseId, opened.caseId)),
    );
    // The used code, tried again, is a refusal on the timeline too.
    expect(events.map((e) => e.type)).toEqual([
      'case_opened',
      'claim_requested',
      'claim_rejected',
      'case_claimed',
      'claim_rejected',
    ]);
    expect(events[3]?.payload).toEqual({ method: 'email', email: 'mette@mail.claim.dk' });
    // A claimed case no longer expires.
    expect(await expireUnclaimedCases(t, at(400)())).not.toContain(opened.caseId);
  });

  it('a code that is not used in time is refused', async () => {
    const opened = await open(t, { company: { ...company, domain: 'late.dk' } });
    const ctx = { caseId: opened.caseId, tenantId: opened.tenantId };
    const challenge = await requestClaim(t, { ...ctx, email: 'a@late.dk', now: at(0) });
    await expect(
      confirmClaim(t, { ...ctx, code: challenge.code, now: at(2) }),
    ).rejects.toMatchObject({
      reason: 'expired',
    });
  });

  it('the override path claims without an address, and says who and why on the timeline', async () => {
    const opened = await open(t, { company: { ...company, domain: 'override.dk' } });
    const ctx = { caseId: opened.caseId, tenantId: opened.tenantId };
    await expect(claimByOverride(t, { ...ctx, by: '', reason: 'x' })).rejects.toThrow(
      /who and why/,
    );
    await claimByOverride(t, {
      ...ctx,
      by: 'lars@gdprcompliant.eu',
      reason: 'Owner has no mailbox at the domain; verified by phone against the registry.',
      now: at(1),
    });
    expect(await caseByToken(t, opened.accessToken)).toMatchObject({
      claimed: true,
      expiresAt: null,
    });
    const [c] = await withTenant(t, opened.tenantId, (db) => db.select().from(schema.cases));
    expect(c?.claimedBy).toBe('override:lars@gdprcompliant.eu');
    const events = await withTenant(t, opened.tenantId, (db) =>
      db.select().from(schema.caseEvents),
    );
    expect(events.at(-1)?.payload).toEqual({
      method: 'override',
      by: 'lars@gdprcompliant.eu',
      reason: 'Owner has no mailbox at the domain; verified by phone against the registry.',
    });
    await expect(claimByOverride(t, { ...ctx, by: 'x', reason: 'y' })).rejects.toMatchObject({
      reason: 'already_claimed',
    });
  });

  it('a second scan of the same domain by the same owner continues the case; a stranger opens a new one', async () => {
    const first = await open(t, { company: { ...company, domain: 'twice.dk' } });
    const again = await open(t, {
      company: { ...company, domain: 'twice.dk' },
      tenantId: first.tenantId,
      now: at(3),
    });
    expect(again).toEqual({ ...first, continued: true });
    const other = await open(t, {
      company: { ...company, domain: 'other.dk' },
      tenantId: first.tenantId,
    });
    expect(other.continued).toBe(false);
    expect(other.tenantId).toBe(first.tenantId);
    const stranger = await open(t, { company: { ...company, domain: 'twice.dk' } });
    expect(stranger.caseId).not.toBe(first.caseId);
    expect(stranger.tenantId).not.toBe(first.tenantId);
    const mine = await withTenant(t, first.tenantId, (db) =>
      db.select({ id: schema.cases.id }).from(schema.cases),
    );
    expect(mine.map((c) => c.id).sort()).toEqual([first.caseId, other.caseId].sort());
  });
});
