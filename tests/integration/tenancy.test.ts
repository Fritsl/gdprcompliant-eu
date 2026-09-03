import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@gc/contracts';
import {
  APP_ROLE,
  SHARED_TENANT,
  createTestDatabase,
  schema,
  testDatabaseUrl,
  withTenant,
  withoutTenant,
  type TestDatabase,
} from '@gc/db';
import {
  migrationsSql,
  rlsCoverage,
  rlsProblems,
  tablesInSnapshot,
} from '../../scripts/rls-check.mjs';

// Tenant isolation, proven (F-05): two tenants side by side, and every way across the
// boundary tried as the app role — read, write, join, aggregate, and no context at all.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const NOW = new Date('2026-09-03T09:14:00Z');

async function failsWith(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  let message = '';
  try {
    await work;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    message = [err.message, err.cause?.message ?? ''].join(' ');
  }
  expect(message).toMatch(pattern);
}

describe.skipIf(!url)('tenant isolation (F-05)', () => {
  let t: TestDatabase;

  // Seeded as the owner: two tenants, a case each, evidence and a finding each.
  beforeAll(async () => {
    t = await createTestDatabase(url);
    await t.db.insert(schema.remedies).values({
      id: 'cns-02-gate-tags',
      version: 1,
      tenantId: SHARED_TENANT,
      sourceRef: 'catalogue',
      findingTypeId: 'CNS-02',
      kind: 'self_fix',
      jurisdictions: 'all',
      content: {},
      hash: sha256('r'),
    });
    for (const [tenant, caseId] of [
      ['tenant-a', 'DK-26-AAAA'],
      ['tenant-b', 'DK-26-BBBB'],
    ] as const) {
      await t.db
        .insert(schema.tenants)
        .values({ id: tenant, name: tenant, tenantId: tenant, sourceRef: 'test' });
      await t.db.insert(schema.cases).values({
        id: caseId,
        tenantId: tenant,
        sourceRef: 'test',
        company: { domain: `${tenant}.dk`, country: 'DK', locale: 'da' },
        jurisdiction: 'DK',
        locale: 'da',
        openedAt: NOW,
        lane: 'self-serve',
      });
      const hash = sha256(`evidence of ${tenant}`);
      await t.db.insert(schema.evidence).values({
        id: `text:${hash.slice(0, 16)}`,
        tenantId: tenant,
        sourceRef: 'test',
        caseId,
        kind: 'text',
        capturedAt: NOW,
        body: `evidence of ${tenant}`,
        hash,
      });
      await t.db.insert(schema.findings).values({
        id: `f-${tenant}`,
        tenantId: tenant,
        sourceRef: 'test',
        caseId,
        typeId: 'CNS-02',
        fingerprint: `CNS-02|${tenant}.dk||`,
        jurisdiction: 'DK',
        binding: {},
        severity: 'blocking',
        area: 'Consent',
        remedyId: 'cns-02-gate-tags',
        remedyVersion: 1,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      });
      await t.db.insert(schema.findingEvidence).values({
        findingId: `f-${tenant}`,
        evidenceId: `text:${hash.slice(0, 16)}`,
        tenantId: tenant,
        sourceRef: 'test',
      });
      await t.db.insert(schema.caseEvents).values({
        id: `e-${tenant}`,
        tenantId: tenant,
        sourceRef: 'test',
        caseId,
        seq: 1,
        at: NOW,
        actor: { kind: 'scanner' },
        type: 'case_opened',
        payload: { source: 'scanner' },
      });
    }
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('every table has row level security enabled and forced, with a policy, in the database and in the lint', async () => {
    const rows = await t.sql<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }[]
    >`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${t.schema} and c.relkind = 'r' and c.relname <> '__drizzle_migrations'
      order by 1`;
    expect(rows.length).toBe(19);
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} enabled`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} forced`).toBe(true);
      expect(r.policies, `${r.relname} policies`).toBeGreaterThan(0);
    }
    const coverage = rlsCoverage(tablesInSnapshot(), migrationsSql());
    expect(Object.keys(coverage).sort()).toEqual(rows.map((r) => r.relname));
    expect(rlsProblems(coverage)).toEqual([]);
    expect(rlsProblems(rlsCoverage(['brand_new_table'], migrationsSql()))).toEqual([
      'brand_new_table: row level security is not enabled',
      'brand_new_table: row level security is not forced for the owner',
      'brand_new_table: no policy',
    ]);
  });

  it('a query without tenant context returns zero rows, never all rows', async () => {
    const seen = await withoutTenant(t, async (tx) => ({
      tenants: (await tx.select().from(schema.tenants)).length,
      cases: (await tx.select().from(schema.cases)).length,
      findings: (await tx.select().from(schema.findings)).length,
      evidence: (await tx.select().from(schema.evidence)).length,
      events: (await tx.select().from(schema.caseEvents)).length,
      count: Number((await tx.execute(sql`select count(*)::int as n from cases`)).at(0)?.['n']),
      shared: (await tx.select().from(schema.jurisdictions)).length,
    }));
    expect(seen).toMatchObject({
      tenants: 0,
      cases: 0,
      findings: 0,
      evidence: 0,
      events: 0,
      count: 0,
    });
    // Reference data is the one thing everyone can read.
    expect(seen.shared).toBeGreaterThanOrEqual(3);
    // And the owner, outside the app role, sees everything: which is why the app never is the owner.
    expect((await t.db.select().from(schema.cases)).length).toBe(2);
  });

  it('tenant A cannot read, join or aggregate tenant B', async () => {
    const seen = await withTenant(t, 'tenant-a', async (tx) => ({
      cases: (await tx.select().from(schema.cases)).map((c) => c.id),
      byId: (await tx.select().from(schema.cases).where(eq(schema.cases.id, 'DK-26-BBBB'))).length,
      joined: (
        await tx
          .select({ finding: schema.findings.id, body: schema.evidence.body })
          .from(schema.findings)
          .innerJoin(
            schema.findingEvidence,
            eq(schema.findingEvidence.findingId, schema.findings.id),
          )
          .innerJoin(schema.evidence, eq(schema.evidence.id, schema.findingEvidence.evidenceId))
      ).map((r) => r.body),
      counted: Number(
        (await tx.execute(sql`select count(*)::int as n from findings`)).at(0)?.['n'],
      ),
      summed: Number(
        (await tx.execute(sql`select coalesce(sum(seq), 0)::int as n from case_events`)).at(0)?.[
          'n'
        ],
      ),
      exists: (await tx.execute(sql`select 1 from evidence where body like '%tenant-b%'`)).length,
    }));
    expect(seen).toEqual({
      cases: ['DK-26-AAAA'],
      byId: 0,
      joined: ['evidence of tenant-a'],
      counted: 1,
      summed: 1,
      exists: 0,
    });
  });

  it('tenant A cannot write into tenant B, or move its own rows there', async () => {
    await withTenant(t, 'tenant-a', async (tx) => {
      const updated = await tx
        .update(schema.cases)
        .set({ watched: true })
        .where(eq(schema.cases.id, 'DK-26-BBBB'))
        .returning();
      expect(updated).toEqual([]);
      const deleted = await tx
        .delete(schema.answers)
        .where(eq(schema.answers.tenantId, 'tenant-b'))
        .returning();
      expect(deleted).toEqual([]);
    });
    // A refused statement aborts its transaction, so each attempt gets its own.
    await failsWith(
      withTenant(t, 'tenant-a', (tx) =>
        tx.insert(schema.answers).values({
          id: 'a-x',
          tenantId: 'tenant-b',
          sourceRef: 'test',
          caseId: 'DK-26-BBBB',
          questionId: 'Q1',
          answer: 'yes',
          answeredBy: { kind: 'scanner' },
          answeredAt: NOW,
        }),
      ),
      /row-level security policy/,
    );
    await failsWith(
      withTenant(t, 'tenant-a', (tx) =>
        tx
          .update(schema.cases)
          .set({ tenantId: 'tenant-b' })
          .where(eq(schema.cases.id, 'DK-26-AAAA')),
      ),
      /row-level security policy/,
    );
    await failsWith(
      withTenant(t, 'tenant-a', (tx) =>
        tx
          .insert(schema.jurisdictions)
          .values({ code: 'XX', name: 'x', tenantId: SHARED_TENANT, sourceRef: 'test' }),
      ),
      /row-level security policy/,
    );
    // Nothing leaked through: B's case is untouched, A's case is still A's, no answer was written.
    expect(
      (await t.db.select().from(schema.cases).where(eq(schema.cases.id, 'DK-26-BBBB')))[0]?.watched,
    ).toBe(false);
    expect(
      (await t.db.select().from(schema.cases).where(eq(schema.cases.id, 'DK-26-AAAA')))[0]
        ?.tenantId,
    ).toBe('tenant-a');
    expect((await t.db.select().from(schema.answers)).length).toBe(0);
  });

  it('the context is scoped to the transaction and the role really is the app role', async () => {
    const inside = await withTenant(t, 'tenant-b', async (tx) => ({
      role: String((await tx.execute(sql`select current_user as u`)).at(0)?.['u']),
      tenant: String(
        (await tx.execute(sql`select current_setting('app.tenant_id', true) as t`)).at(0)?.['t'],
      ),
      cases: (await tx.select().from(schema.cases)).map((c) => c.id),
    }));
    expect(inside).toEqual({ role: APP_ROLE, tenant: 'tenant-b', cases: ['DK-26-BBBB'] });
    const after =
      await t.sql`select current_setting('app.tenant_id', true) as t, current_user as u`;
    expect(after[0]?.['t'] ?? '').toBe('');
    expect(after[0]?.['u']).not.toBe(APP_ROLE);
    await expect(withTenant(t, 'tenant-b; drop table cases', async () => 1)).rejects.toThrow(
      /not a tenant id/,
    );
  });
});
