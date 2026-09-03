import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@gc/contracts';
import {
  SHARED_TENANT,
  createTestDatabase,
  schema,
  testDatabaseUrl,
  type TestDatabase,
} from '@gc/db';
import { latestSnapshot, render, TARGET } from '../../scripts/schema-doc.mjs';

// The spine (F-03): the columns every table carries, the constraints that make the
// product rules structural, and the generated schema document.

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
const HASH = sha256('connect.facebook.net loaded loaded identical');
// Drizzle wraps a Postgres error ('Failed query: ...') and keeps the constraint name in
// the cause; both messages count.
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

describe.skipIf(!url)('the core relational schema (F-03)', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase(url);
    await t.db
      .insert(schema.tenants)
      .values({ id: 't-1', name: 'Eksempelbutik ApS', tenantId: 't-1', sourceRef: 'test' });
    await t.db.insert(schema.cases).values({
      id: 'DK-26-0M4K',
      tenantId: 't-1',
      sourceRef: 'scanner:scan-1',
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      openedAt: NOW,
      lane: 'self-serve',
      laneScore: 34,
    });
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('every table carries tenant_id, created_at and source_ref', async () => {
    const rows = await t.sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = ${t.schema} and table_name <> '__drizzle_migrations'`;
    const byTable = new Map<string, Set<string>>();
    for (const r of rows)
      byTable.set(r.table_name, (byTable.get(r.table_name) ?? new Set()).add(r.column_name));
    expect([...byTable.keys()].sort()).toEqual([
      'answers',
      'app_meta',
      'case_events',
      'cases',
      'demand_entries',
      'evidence',
      'finding_evidence',
      'findings',
      'jurisdictions',
      'processing_activities',
      'remedies',
      'tenants',
      'vendors',
    ]);
    for (const [table, columns] of byTable) {
      for (const c of ['tenant_id', 'created_at', 'source_ref'])
        expect(columns.has(c), `${table}.${c}`).toBe(true);
    }
  });

  it('jurisdictions are seeded as shared reference data', async () => {
    const rows = await t.db.select().from(schema.jurisdictions);
    expect(rows.map((r) => [r.code, r.supported, r.tenantId])).toEqual(
      expect.arrayContaining([
        ['DK', true, SHARED_TENANT],
        ['DE', true, SHARED_TENANT],
        ['EU', false, SHARED_TENANT],
      ]),
    );
  });

  it('case_events is append-only: an UPDATE or DELETE raises', async () => {
    await t.db.insert(schema.caseEvents).values({
      id: 'e-1',
      tenantId: 't-1',
      sourceRef: 'scanner:scan-1',
      caseId: 'DK-26-0M4K',
      seq: 1,
      at: NOW,
      actor: { kind: 'scanner' },
      type: 'case_opened',
      payload: { source: 'scanner' },
    });
    await failsWith(t.sql`update case_events set payload = '{}' where id = 'e-1'`, /append-only/);
    await failsWith(t.sql`delete from case_events where id = 'e-1'`, /append-only/);
    await failsWith(
      t.db.insert(schema.caseEvents).values({
        id: 'e-2',
        tenantId: 't-1',
        sourceRef: 'x',
        caseId: 'DK-26-0M4K',
        seq: 1,
        at: NOW,
        actor: { kind: 'scanner' },
        type: 'case_opened',
        payload: {},
      }),
      /case_events_case_seq/,
    );
    await failsWith(
      t.db.insert(schema.caseEvents).values({
        id: 'e-3',
        tenantId: 't-1',
        sourceRef: 'x',
        caseId: 'DK-26-0M4K',
        seq: 2,
        at: NOW,
        actor: { kind: 'scanner' },
        type: 'something_happened',
        payload: {},
      }),
      /case_events_type/,
    );
  });

  it('evidence rows are immutable and content-addressed by hash', async () => {
    const row = {
      tenantId: 't-1',
      sourceRef: 'scanner:scan-1',
      caseId: 'DK-26-0M4K',
      kind: 'pass_diff',
      capturedAt: NOW,
      observed: { host: 'eksempelbutik.dk', pass: 'B' },
      body: 'connect.facebook.net loaded loaded identical',
      hash: HASH,
    };
    await t.db.insert(schema.evidence).values({ id: `pass_diff:${HASH.slice(0, 16)}`, ...row });
    await failsWith(t.sql`update evidence set body = 'edited' where hash = ${HASH}`, /immutable/);
    await failsWith(t.sql`delete from evidence where hash = ${HASH}`, /immutable/);
    // The id must be the kind and the hash; the same content cannot be stored twice.
    await failsWith(
      t.db.insert(schema.evidence).values({ id: 'pass_diff:wrong', ...row, hash: sha256('other') }),
      /evidence_id/,
    );
    await failsWith(
      t.db
        .insert(schema.evidence)
        .values({ id: `text:${HASH.slice(0, 16)}`, ...row, kind: 'text' }),
      /evidence_tenant_hash/,
    );
  });

  it('a finding without a remedy cannot be inserted', async () => {
    const finding = {
      id: 'f-1',
      tenantId: 't-1',
      sourceRef: 'scanner:scan-1',
      caseId: 'DK-26-0M4K',
      typeId: 'CNS-02',
      fingerprint: 'CNS-02|eksempelbutik.dk||',
      jurisdiction: 'DK',
      binding: { findingTypeId: 'CNS-02', jurisdiction: 'DK' },
      severity: 'blocking',
      area: 'Consent',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    };
    // NOT NULL: no remedy at all.
    await failsWith(
      t.sql`insert into findings (id, tenant_id, source_ref, case_id, type_id, fingerprint, jurisdiction, binding, severity, area, first_seen_at, last_seen_at)
      values ('f-0', 't-1', 'x', 'DK-26-0M4K', 'CNS-02', 'fp', 'DK', '{}', 'blocking', 'Consent', now(), now())`,
      /remedy_id/,
    );
    // A remedy that is not in the catalogue.
    await failsWith(
      t.db.insert(schema.findings).values({ ...finding, remedyId: 'nope', remedyVersion: 1 }),
      /findings_remedy_fk/,
    );
    await t.db.insert(schema.remedies).values({
      id: 'cns-02-gate-tags',
      version: 1,
      tenantId: SHARED_TENANT,
      sourceRef: 'catalogue',
      findingTypeId: 'CNS-02',
      kind: 'self_fix',
      jurisdictions: 'all',
      content: { title: { en: 'Move the tags behind the consent state' } },
      hash: sha256('cns-02-gate-tags@1'),
    });
    await t.db
      .insert(schema.findings)
      .values({ ...finding, remedyId: 'cns-02-gate-tags', remedyVersion: 1 });
    await t.db.insert(schema.findingEvidence).values({
      findingId: 'f-1',
      evidenceId: `pass_diff:${HASH.slice(0, 16)}`,
      tenantId: 't-1',
      sourceRef: 'scanner:scan-1',
      quote: 'connect.facebook.net',
    });
    const stored = await t.db.select().from(schema.findings);
    expect(stored.map((f) => [f.id, f.remedyId, f.remedyVersion, f.status])).toEqual([
      ['f-1', 'cns-02-gate-tags', 1, 'open'],
    ]);
    // A link can be dropped; the evidence row it pointed at still cannot change.
    await t.sql`delete from finding_evidence where finding_id = 'f-1'`;
    await failsWith(t.sql`delete from evidence where hash = ${HASH}`, /immutable/);
    await failsWith(
      t.sql`update findings set status = 'closed' where id = 'f-1'`,
      /findings_closed/,
    );
  });

  it('vendors, processing activities and answers take the shapes the contracts describe', async () => {
    await t.db.insert(schema.vendors).values({
      id: 'v-ms',
      tenantId: 't-1',
      sourceRef: 'scanner:scan-1',
      caseId: 'DK-26-0M4K',
      label: 'Mail & files suite',
      jurisdiction: 'IE',
      parentJurisdiction: 'US',
      role: 'processor',
      level: 1,
      hosts: ['outlook.office365.com'],
      resolution: 'resolved',
      provenance: { source: 'observation', seenAt: NOW.toISOString(), evidence: [] },
      legalEntity: { name: 'Microsoft Ireland Operations Ltd' },
    });
    await failsWith(
      t.db.insert(schema.vendors).values({
        id: 'v-x',
        tenantId: 't-1',
        sourceRef: 'x',
        caseId: 'DK-26-0M4K',
        label: 'x',
        jurisdiction: 'DK',
        role: 'landlord',
        resolution: 'resolved',
        provenance: {},
      }),
      /vendors_role/,
    );
    await t.db.insert(schema.processingActivities).values({
      id: 'pa-1',
      tenantId: 't-1',
      sourceRef: 'answer:Q3',
      caseId: 'DK-26-0M4K',
      name: 'Order handling',
      purpose: 'Fulfilling orders',
      origin: 'answered',
      confidence: 1,
    });
    await t.db.insert(schema.answers).values({
      id: 'a-1',
      tenantId: 't-1',
      sourceRef: 'answer:Q3',
      caseId: 'DK-26-0M4K',
      questionId: 'Q3',
      answer: '5 years',
      answeredBy: { kind: 'person', userId: 'u-1', name: 'Mette' },
      answeredAt: NOW,
    });
    expect((await t.db.select().from(schema.answers)).length).toBe(1);
  });
});

describe('docs/schema.md is generated, not hand-drawn (F-03)', () => {
  it('matches the latest snapshot exactly', () => {
    const doc = render(latestSnapshot());
    expect(readFileSync(TARGET, 'utf8')).toBe(doc);
    expect(doc).toMatch(/^# Schema/);
    expect(doc).toContain('erDiagram');
    expect(doc).toContain('findings ||--o{ finding_evidence');
    expect(doc).toContain('remedies ||--o{ findings');
  });
});
