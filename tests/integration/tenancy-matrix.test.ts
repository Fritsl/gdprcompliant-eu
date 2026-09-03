import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@gc/contracts';
import {
  SHARED_TENANT,
  caseSummary,
  caseTimeline,
  claimByOverride,
  confirmClaim,
  createTestDatabase,
  deleteCase,
  exportCase,
  grantFullAccess,
  inviteMember,
  memberView,
  openCase,
  rankedDemand,
  requestClaim,
  schema,
  syncCaseStage,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { JobQueue, defineJob } from '@gc/jobs';
import { loadCatalogue } from '@gc/remedies';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { GET as exportRoute } from '@/app/[locale]/c/[token]/export.json/route';
import { GET as timelinePdfRoute } from '@/app/[locale]/c/[token]/timeline.pdf/route';
import { POST as deleteRoute } from '@/app/[locale]/c/[token]/delete/route';
import { GET as demandCsvRoute } from '@/app/[locale]/demand.csv/route';

// The tenancy and access-control matrix (T-07): tenant A, holding everything a tenant
// can hold, tries every way across to tenant B: direct queries, joins, aggregates, job
// payloads, export endpoints, invitation links, and every route the app serves. Each
// attempt yields A's own data or nothing, never B's. Runs on every push (CI job
// "tenancy") against a real Postgres.

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
const catalogue = loadCatalogue();
const remedy = (id: string) => {
  const entry = catalogue.get(id)!;
  return { kind: entry.remedy.kind, title: entry.remedy.title.en ?? id };
};

interface Side {
  caseId: string;
  tenantId: string;
  token: string;
  memberToken: string;
  memberId: string;
  evidenceBody: string;
}

describe.skipIf(!url)('tenant A against tenant B, every way across (T-07)', () => {
  let t: TestDatabase;
  const A = {} as Side;
  const B = {} as Side;
  const params = (token: string) => ({ params: Promise.resolve({ locale: 'en', token }) });

  async function populate(side: Side, label: string, domain: string): Promise<void> {
    const opened = await openCase(t, {
      company: { domain, country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => T0,
    });
    side.caseId = opened.caseId;
    side.tenantId = opened.tenantId;
    side.token = opened.accessToken;
    side.evidenceBody = `${label} evidence ${randomBytes(6).toString('hex')}`;
    const hash = sha256(side.evidenceBody);
    await withTenant(t, side.tenantId, async (db) => {
      await db.insert(schema.evidence).values({
        id: `text:${hash.slice(0, 16)}`,
        tenantId: side.tenantId,
        sourceRef: 'test',
        caseId: side.caseId,
        kind: 'text',
        capturedAt: T0,
        body: side.evidenceBody,
        hash,
      });
      await db.insert(schema.findings).values({
        id: `f-${label}`,
        tenantId: side.tenantId,
        sourceRef: 'test',
        caseId: side.caseId,
        typeId: 'SEC-03',
        fingerprint: `SEC-03|${domain}`,
        jurisdiction: 'DK',
        binding: {},
        severity: 'serious',
        area: 'Security',
        remedyId: 'sec-03-hsts',
        remedyVersion: 1,
        firstSeenAt: T0,
        lastSeenAt: T0,
      });
      await db.insert(schema.findingEvidence).values({
        findingId: `f-${label}`,
        evidenceId: `text:${hash.slice(0, 16)}`,
        tenantId: side.tenantId,
        sourceRef: 'test',
      });
      await db.insert(schema.answers).values({
        id: `a-${label}`,
        tenantId: side.tenantId,
        sourceRef: 'test',
        caseId: side.caseId,
        questionId: 'Q1',
        answer: `${label} answer`,
        answeredBy: { kind: 'scanner' },
        answeredAt: T0,
      });
    });
    const invite = await inviteMember(t, {
      invitedBy: 'Mette',
      baseUrl: 'https://gdprcompliant.eu',
      caseId: side.caseId,
      tenantId: side.tenantId,
      role: 'it',
      email: `it@${domain}`,
      now: () => T0,
    });
    side.memberToken = invite.inviteToken;
    side.memberId = invite.memberId;
  }

  beforeAll(async () => {
    t = await createTestDatabase(url);
    await t.db.insert(schema.remedies).values({
      id: 'sec-03-hsts',
      version: 1,
      tenantId: SHARED_TENANT,
      sourceRef: 'catalogue',
      findingTypeId: 'SEC-03',
      kind: 'self_fix',
      jurisdictions: 'all',
      content: {},
      hash: sha256('sec-03'),
    });
    await populate(A, 'a', 'a-side.dk');
    await populate(B, 'b', 'b-side.dk');
    const challenge = await requestClaim(t, {
      caseId: B.caseId,
      tenantId: B.tenantId,
      email: 'owner@b-side.dk',
      now: () => T0,
    });
    await confirmClaim(t, {
      caseId: B.caseId,
      tenantId: B.tenantId,
      code: challenge.code,
      now: () => T0,
    });
    // The web app's server modules read the disposable schema for this file.
    process.env['DATABASE_URL'] = url;
    process.env['GC_SEARCH_PATH'] = `${t.schema},public`;
  });

  afterAll(async () => {
    delete process.env['DATABASE_URL'];
    delete process.env['GC_SEARCH_PATH'];
    await t?.drop();
  });

  const leaksB = (value: unknown) => {
    const text = JSON.stringify(value) ?? '';
    return [
      B.caseId,
      B.tenantId,
      B.token,
      B.memberToken,
      B.evidenceBody,
      'b-side.dk',
      'b answer',
    ].filter((n) => text.includes(n));
  };

  it('direct queries, joins and aggregates as A never reach B', async () => {
    const seen = await withTenant(t, A.tenantId, async (db) => ({
      cases: (await db.select().from(schema.cases)).map((c) => c.id),
      byId: (await db.select().from(schema.cases).where(eq(schema.cases.id, B.caseId))).length,
      joined: (
        await db
          .select({ body: schema.evidence.body })
          .from(schema.findings)
          .innerJoin(
            schema.findingEvidence,
            eq(schema.findingEvidence.findingId, schema.findings.id),
          )
          .innerJoin(schema.evidence, eq(schema.evidence.id, schema.findingEvidence.evidenceId))
      ).map((r) => r.body),
      counted: Number(
        (await db.execute(sql`select count(*)::int as n from findings`)).at(0)?.['n'],
      ),
      answers: (await db.select().from(schema.answers)).map((a) => a.answer),
      members: (await db.select().from(schema.caseMembers)).map((m) => m.email),
      claims: (await db.select().from(schema.caseClaims)).length,
      events: (await db.select().from(schema.caseEvents)).map((e) => e.caseId),
      updated: (
        await db
          .update(schema.cases)
          .set({ watched: true })
          .where(eq(schema.cases.id, B.caseId))
          .returning()
      ).length,
      deleted: (
        await db.delete(schema.answers).where(eq(schema.answers.caseId, B.caseId)).returning()
      ).length,
    }));
    expect(seen.cases).toEqual([A.caseId]);
    expect(seen.byId).toBe(0);
    expect(seen.joined).toEqual([A.evidenceBody]);
    expect(seen.counted).toBe(1);
    expect(seen.answers).toEqual(['a answer']);
    expect(seen.members).toEqual(['it@a-side.dk']);
    expect(seen.claims).toBe(0);
    expect(new Set(seen.events)).toEqual(new Set([A.caseId]));
    expect(seen.updated).toBe(0);
    expect(seen.deleted).toBe(0);
    expect(leaksB(seen)).toEqual([]);
  });

  it('every service that takes a tenant and a case refuses the pair (A, case of B)', async () => {
    const pair = { caseId: B.caseId, tenantId: A.tenantId };
    await expect(caseSummary(t, A.tenantId, B.caseId)).rejects.toThrow(/no case/);
    await expect(exportCase(t, A.tenantId, B.caseId, { locale: 'en' })).rejects.toThrow(/no case/);
    await expect(deleteCase(t, A.tenantId, B.caseId, { requestedBy: 'owner' })).rejects.toThrow(
      /no case/,
    );
    await expect(requestClaim(t, { ...pair, email: 'x@b-side.dk' })).rejects.toMatchObject({
      reason: 'not_found',
    });
    await expect(claimByOverride(t, { ...pair, by: 'a', reason: 'trying' })).rejects.toMatchObject({
      reason: 'not_found',
    });
    await expect(
      inviteMember(t, {
        invitedBy: 'Mette',
        baseUrl: 'https://gdprcompliant.eu',
        ...pair,
        role: 'hr',
        email: 'hr@b-side.dk',
      }),
    ).rejects.toThrow(/no case/);
    await expect(grantFullAccess(t, A.tenantId, B.caseId, B.memberId)).rejects.toThrow(/no member/);
    await expect(syncCaseStage(t, A.tenantId, B.caseId)).rejects.toThrow(/no case/);
    // Nothing happened to B: no event, no member, still claimed, still there.
    const events = await withTenant(t, B.tenantId, (db) => caseTimeline(db, B.caseId));
    expect(events.map((e) => e.type)).toEqual([
      'case_opened',
      'colleague_invited',
      'claim_requested',
      'case_claimed',
    ]);
    const members = await withTenant(t, B.tenantId, (db) => db.select().from(schema.caseMembers));
    expect(members.map((m) => m.email)).toEqual(['it@b-side.dk']);
  });

  it('a job payload naming B, run as A, finds nothing', async () => {
    const job = defineJob({
      name: 'matrix-probe',
      payload: z.object({ tenantId: z.string(), caseId: z.string() }),
    });
    const queue = new JobQueue({
      connectionString: url!,
      schema: `pgboss_${randomBytes(4).toString('hex')}`,
      pollingIntervalSeconds: 0.5,
    });
    await queue.start();
    try {
      const seen: unknown[] = [];
      await queue.work(job, async (j) => {
        seen.push(
          await withTenant(t, j.payload.tenantId, async (db) => ({
            cases: (
              await db.select().from(schema.cases).where(eq(schema.cases.id, j.payload.caseId))
            ).map((c) => c.id),
            evidence: (
              await db
                .select()
                .from(schema.evidence)
                .where(eq(schema.evidence.caseId, j.payload.caseId))
            ).map((e) => e.body),
          })),
        );
      });
      await queue.enqueue(job, { tenantId: A.tenantId, caseId: B.caseId });
      await queue.enqueue(job, { tenantId: A.tenantId, caseId: A.caseId });
      const deadline = Date.now() + 15_000;
      while (seen.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      expect(seen).toEqual(
        expect.arrayContaining([
          { cases: [], evidence: [] },
          { cases: [A.caseId], evidence: [A.evidenceBody] },
        ]),
      );
      expect(leaksB(seen)).toEqual([]);
    } finally {
      await queue.drop();
      await queue.stop({ graceful: false });
    }
  });

  it('exports and the ranked ledger carry nothing of B', async () => {
    const mine = await exportCase(t, A.tenantId, A.caseId, { locale: 'en', now: () => T0 });
    expect(mine.json).toContain(A.evidenceBody);
    expect(leaksB(JSON.parse(mine.json))).toEqual([]);
    const ranked = await rankedDemand(t, { k: 2 });
    expect(leaksB(ranked)).toEqual([]);
    expect(JSON.stringify(ranked)).not.toContain(A.caseId);
  });

  it('invitation links: a member of A sees A, only their role, and cannot be pointed at B', async () => {
    const view = await memberView(t, A.memberToken, { locale: 'en', remedy });
    expect(view?.member).toMatchObject({ caseId: A.caseId, tenantId: A.tenantId, role: 'it' });
    expect(view?.lists.map((l) => l.role)).toEqual(['it']);
    expect(leaksB(view)).toEqual([]);
    // One hex digit off B's token: never B's, whatever the last digit was.
    const forged = B.memberToken.slice(0, 63) + (B.memberToken.endsWith('0') ? '1' : '0');
    expect(await memberView(t, forged, { locale: 'en', remedy })).toBeUndefined();
    expect(await memberView(t, 'f'.repeat(64), { locale: 'en', remedy })).toBeUndefined();
    // The owner of A cannot grant A's member anything on B.
    await expect(grantFullAccess(t, A.tenantId, B.caseId, A.memberId)).rejects.toThrow(/no member/);
  });

  it("every route the app serves: with A's token it answers A, with anything else nothing", async () => {
    const exported = await exportRoute(new Request('http://x/'), params(A.token));
    expect(exported.status).toBe(200);
    const body = await exported.text();
    expect(body).toContain(A.evidenceBody);
    expect(leaksB(JSON.parse(body))).toEqual([]);

    const pdf = await timelinePdfRoute(new Request('http://x/'), params(A.token));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');

    for (const bad of ['f'.repeat(64), B.caseId, `${A.token}x`, '']) {
      expect((await exportRoute(new Request('http://x/'), params(bad))).status, bad).toBe(404);
      expect((await timelinePdfRoute(new Request('http://x/'), params(bad))).status, bad).toBe(404);
    }

    // Delete with A's token and B's number as confirmation: nothing, and B is intact.
    const form = new FormData();
    form.set('confirm', B.caseId);
    const refused = await deleteRoute(
      new Request('http://x/en/c/x/delete', { method: 'POST', body: form }),
      params(A.token),
    );
    expect(refused.status).toBe(404);
    expect((await withTenant(t, B.tenantId, (db) => db.select().from(schema.cases))).length).toBe(
      1,
    );
    expect((await withTenant(t, A.tenantId, (db) => db.select().from(schema.cases))).length).toBe(
      1,
    );

    const csv = await demandCsvRoute(new Request('http://x/'), {
      params: Promise.resolve({ locale: 'en' }),
    });
    expect(csv.status).toBe(200);
    expect(leaksB(await csv.text())).toEqual([]);
  });
});
