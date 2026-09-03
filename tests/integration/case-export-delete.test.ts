import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@gc/contracts';
import {
  DELETE_TIME_BOUND_MS,
  EXPORT_TIME_BOUND_MS,
  SHARED_TENANT,
  PostgresDemandLedger,
  TABLES,
  appendCaseEvent,
  caseByToken,
  caseSummary,
  createTestDatabase,
  deleteCase,
  deletionStubId,
  exportCase,
  openCase,
  requestClaim,
  confirmClaim,
  schema,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { eq, sql } from 'drizzle-orm';

// Proving the case is theirs (C-04): a populated case exported as one openable file
// with everything in it, then hard-deleted so that nothing survives but the anonymous
// stub; both inside their time bounds, both on the timeline.

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

describe.skipIf(!url)('export and delete (C-04)', () => {
  let t: TestDatabase;
  let caseId = '';
  let tenantId = '';
  let token = '';
  let otherCaseId = '';

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => T0,
    });
    caseId = opened.caseId;
    tenantId = opened.tenantId;
    token = opened.accessToken;
    // A second case of the same owner, which must survive the first one's deletion.
    otherCaseId = (
      await openCase(t, {
        company: { domain: 'other.dk', country: 'DK', locale: 'da' },
        jurisdiction: 'DK',
        locale: 'da',
        tenantId,
        now: () => T0,
      })
    ).caseId;

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
    await withTenant(t, tenantId, async (db) => {
      for (const target of [caseId, otherCaseId]) {
        const body = `page text of ${target}`;
        const hash = sha256(body);
        await db.insert(schema.evidence).values({
          id: `text:${hash.slice(0, 16)}`,
          tenantId,
          sourceRef: 'test',
          caseId: target,
          kind: 'text',
          capturedAt: T0,
          body,
          hash,
        });
        await db.insert(schema.findings).values({
          id: `f-${target}`,
          tenantId,
          sourceRef: 'test',
          caseId: target,
          typeId: 'CNS-02',
          fingerprint: `CNS-02|${target}`,
          jurisdiction: 'DK',
          binding: {},
          severity: 'blocking',
          area: 'Consent',
          remedyId: 'cns-02-gate-tags',
          remedyVersion: 1,
          firstSeenAt: T0,
          lastSeenAt: T0,
        });
        await db.insert(schema.findingEvidence).values({
          findingId: `f-${target}`,
          evidenceId: `text:${hash.slice(0, 16)}`,
          tenantId,
          sourceRef: 'test',
        });
        await db.insert(schema.answers).values({
          id: `a-${target}`,
          tenantId,
          sourceRef: 'test',
          caseId: target,
          questionId: 'Q1',
          answer: 'yes',
          answeredBy: { kind: 'scanner' },
          answeredAt: T0,
        });
        await db.insert(schema.vendors).values({
          id: `v-${target}`,
          tenantId,
          sourceRef: 'test',
          caseId: target,
          label: 'Analytics vendor',
          jurisdiction: 'US',
          role: 'processor',
          resolution: 'resolved',
          provenance: {},
        });
        await appendCaseEvent(db, {
          tenantId,
          caseId: target,
          at: T0,
          actor: { kind: 'person', userId: 'u1', name: 'Mette' },
          type: 'note_added',
          payload: { text: `note on ${target}` },
        });
        await new PostgresDemandLedger(db, tenantId, { country: 'DK' }, () => T0).record({
          findingTypeId: 'XYZ-99',
          jurisdiction: 'DK',
          caseId: target,
          gap: 'nothing',
          cause: 'none',
          answer: 'none',
        });
      }
    });
    const challenge = await requestClaim(t, {
      caseId,
      tenantId,
      email: 'm@eksempelbutik.dk',
      now: () => T0,
    });
    await confirmClaim(t, { caseId, tenantId, code: challenge.code, now: () => T0 });
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('the summary counts what is held, without writing anything', async () => {
    const before = (await withTenant(t, tenantId, (db) => db.select().from(schema.caseEvents)))
      .length;
    const summary = await caseSummary(t, tenantId, caseId);
    expect(summary).toEqual({
      caseId,
      stage: 'opened',
      claimed: true,
      counts: { findings: 1, evidence: 1, answers: 1, events: 4, vendors: 1, activities: 0 },
    });
    expect(
      (await withTenant(t, tenantId, (db) => db.select().from(schema.caseEvents))).length,
    ).toBe(before);
  });

  it('exports everything as one file, with the PDF inside, and writes the export to the timeline', async () => {
    const result = await exportCase(t, tenantId, caseId, { locale: 'da', now: () => T0 });
    expect(result.durationMs).toBeLessThan(EXPORT_TIME_BOUND_MS);
    expect(result.sha256).toBe(sha256(result.json));
    expect(result.bytes).toBe(Buffer.byteLength(result.json));

    const bundle = JSON.parse(result.json) as Record<string, unknown[]> & {
      case: Record<string, unknown>;
      documents: { kind: string; filename: string; mediaType: string; base64: string }[];
    };
    expect(bundle['format']).toBe('gdprcompliant.eu/case-export');
    expect(bundle.case['id']).toBe(caseId);
    expect(bundle.case).not.toHaveProperty('accessToken');
    expect(bundle.case).not.toHaveProperty('tenantId');
    expect(bundle['findings']).toHaveLength(1);
    expect(bundle['evidence']).toHaveLength(1);
    expect((bundle['evidence'][0] as { body: string }).body).toBe(`page text of ${caseId}`);
    expect(bundle['findingEvidence']).toHaveLength(1);
    expect(bundle['answers']).toHaveLength(1);
    expect(bundle['vendors']).toHaveLength(1);
    expect(bundle['claims']).toHaveLength(1);
    expect(bundle['claims'][0]).not.toHaveProperty('codeHash');
    expect(bundle['demandEntries']).toHaveLength(1);
    expect((bundle['timeline'] as { type: string }[]).map((e) => e.type)).toEqual([
      'case_opened',
      'note_added',
      'claim_requested',
      'case_claimed',
    ]);
    expect(bundle.documents).toEqual([
      expect.objectContaining({
        kind: 'timeline',
        filename: `${caseId}-timeline.pdf`,
        mediaType: 'application/pdf',
      }),
    ]);
    expect(Buffer.from(bundle.documents[0]!.base64, 'base64').subarray(0, 5).toString()).toBe(
      '%PDF-',
    );
    expect(result.json).not.toContain(token);

    const events = await withTenant(t, tenantId, (db) =>
      db.select().from(schema.caseEvents).where(eq(schema.caseEvents.caseId, caseId)),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'export_produced',
      payload: { bytes: result.bytes, sha256: result.sha256 },
    });
  });

  it('deletes everything, leaves the anonymous stub and the other case, and is on the timeline until the end', async () => {
    const stub = await deleteCase(t, tenantId, caseId, { requestedBy: 'owner', now: () => T0 });
    expect(stub.durationMs).toBeLessThan(DELETE_TIME_BOUND_MS);
    expect(stub).toMatchObject({ id: deletionStubId(caseId), country: 'DK', year: 2026 });
    // case + 6 events + evidence + finding + link + answer + vendor + claim + ledger entry
    expect(stub.rowsRemoved).toBe(14);

    // Nothing of the case survives, in any table, as seen by the owner.
    for (const [name, table] of Object.entries(TABLES)) {
      if (
        name === 'deletionAudit' ||
        name === 'appMeta' ||
        name === 'jurisdictions' ||
        name === 'remedies'
      )
        continue;
      const rows = (await t.db.select().from(table)) as Record<string, unknown>[];
      const leak = rows.filter((r) => JSON.stringify(r).includes(caseId));
      expect(leak, name).toEqual([]);
    }
    expect(await caseByToken(t, token)).toBeUndefined();

    // The stub: a hash, a country, a year, a count. No number, no domain, no address.
    const audit = await t.db.select().from(schema.deletionAudit);
    expect(audit).toEqual([
      expect.objectContaining({
        id: deletionStubId(caseId),
        tenantId: 'shared',
        country: 'DK',
        year: 2026,
        requestedBy: 'owner',
        rowsRemoved: 14,
      }),
    ]);
    for (const never of [caseId, 'eksempelbutik', 'm@', tenantId]) {
      expect(JSON.stringify(audit), never).not.toContain(never);
    }

    // The owner's other case, and the tenant, are untouched.
    const remaining = await withTenant(t, tenantId, (db) =>
      db.select({ id: schema.cases.id }).from(schema.cases),
    );
    expect(remaining.map((c) => c.id)).toEqual([otherCaseId]);
    expect(
      (await t.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId))).length,
    ).toBe(1);

    // The triggers are back to refusing: nothing else can delete an event or evidence.
    let refused = '';
    try {
      await t.db.execute(sql`delete from case_events where case_id = ${otherCaseId}`);
    } catch (e) {
      refused = String((e as Error & { cause?: Error }).cause?.message ?? (e as Error).message);
    }
    expect(refused).toMatch(/append-only/);
  });

  it('deleting the last case of a tenant takes the tenant with it', async () => {
    await deleteCase(t, tenantId, otherCaseId, {
      requestedBy: 'operator',
      reason: 'test',
      now: () => T0,
    });
    expect(
      (await t.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId))).length,
    ).toBe(0);
    expect((await t.db.select().from(schema.deletionAudit)).length).toBe(2);
  });
});
