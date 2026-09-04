import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GRAPH_EDGE_ENDS, GraphNodeSchema, sha256 } from '@gc/contracts';
import {
  addEdge,
  assertFact,
  contradictions,
  createTestDatabase,
  exportCase,
  graphOf,
  openContradictions,
  openCase,
  registerProjection,
  resolveContradiction,
  schema,
  testDatabaseUrl,
  withTenant,
  type Db,
  type TestDatabase,
} from '@gc/db';

// The case graph (A-01): every node and edge carries where it came from, how sure it is
// and when, and the database refuses one that does not; derived, asserted and answered
// facts are told apart; two statements about one subject both stay with a contradiction
// between them until a person decides; and the register is read off the graph, stored
// nowhere else.

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
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

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

describe.skipIf(!url)('the case graph (A-01)', () => {
  let t: TestDatabase;
  let tenantId = '';
  let caseId = '';
  let evidenceRef: { evidenceId: string; hash: string };
  const base = () => ({ tenantId, caseId, at: T0, confidence: 0.8 });

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => T0,
    });
    tenantId = opened.tenantId;
    caseId = opened.caseId;
    const body = 'v=spf1 include:_spf.google.com ~all';
    const hash = sha256(body);
    evidenceRef = { evidenceId: `registry_record:${hash.slice(0, 16)}`, hash };
    await withTenant(t, tenantId, (db) =>
      db.insert(schema.evidence).values({
        id: evidenceRef.evidenceId,
        tenantId,
        sourceRef: 'dns',
        caseId,
        kind: 'registry_record',
        capturedAt: T0,
        body,
        hash,
        caption: 'TXT eksempelbutik.dk',
      }),
    );
  });

  afterAll(async () => {
    await t?.drop();
  });

  const inTenant = <T>(work: (db: Db) => Promise<T>) => withTenant(t, tenantId, work);

  it('every node and edge carries source, confidence and timestamp, and the database refuses one without', async () => {
    const google = await inTenant((db) =>
      assertFact(db, {
        ...base(),
        kind: 'vendor',
        key: 'vendor:google',
        attributes: { name: 'Google Workspace', country: 'IE' },
        origin: 'derived',
        sourceRef: 'scanner:dns',
        evidence: [evidenceRef],
      }),
    );
    expect(google.inserted).toBe(true);
    expect(google.node).toMatchObject({
      origin: 'derived',
      confidence: 0.8,
      sourceRef: 'scanner:dns',
      at: T0.toISOString(),
    });
    expect(GraphNodeSchema.safeParse(google.node).success).toBe(true);
    // Stated twice from the same source, it is one row.
    const again = await inTenant((db) =>
      assertFact(db, {
        ...base(),
        kind: 'vendor',
        key: 'vendor:google',
        attributes: { name: 'Google Workspace', country: 'IE' },
        origin: 'derived',
        sourceRef: 'scanner:dns',
        evidence: [evidenceRef],
      }),
    );
    expect(again.inserted).toBe(false);
    expect(again.node.id).toBe(google.node.id);

    // A derived fact without evidence, an assertion without a person, an answer without
    // its answer, a confidence outside [0, 1]: the contract refuses each, and so does
    // the table when the contract is bypassed.
    await failsWith(
      inTenant((db) =>
        assertFact(db, { ...base(), kind: 'purpose', key: 'p', origin: 'derived', sourceRef: 'x' }),
      ),
      /derived fact points at evidence/,
    );
    await failsWith(
      inTenant((db) =>
        assertFact(db, {
          ...base(),
          kind: 'purpose',
          key: 'p',
          origin: 'asserted',
          sourceRef: 'x',
        }),
      ),
      /asserted fact names who asserted it/,
    );
    await failsWith(
      inTenant((db) =>
        assertFact(db, {
          ...base(),
          kind: 'purpose',
          key: 'p',
          origin: 'answered',
          sourceRef: 'x',
        }),
      ),
      /answered fact names the answer/,
    );
    await failsWith(
      inTenant((db) =>
        db.insert(schema.graphNodes).values({
          id: 'node:purpose:raw',
          tenantId,
          sourceRef: 'raw',
          caseId,
          kind: 'purpose',
          key: 'p',
          origin: 'derived',
          confidence: 0.5,
          evidence: [],
          at: T0,
        }),
      ),
      /graph_nodes_provenance/,
    );
    await failsWith(
      inTenant((db) =>
        db.insert(schema.graphNodes).values({
          id: 'node:purpose:raw2',
          tenantId,
          sourceRef: 'raw',
          caseId,
          kind: 'purpose',
          key: 'p',
          origin: 'asserted',
          assertedBy: 'Mette',
          confidence: 1.5,
          evidence: [],
          at: T0,
        }),
      ),
      /graph_nodes_confidence/,
    );
    await failsWith(
      inTenant((db) =>
        db.insert(schema.graphNodes).values({
          id: 'node:x:raw3',
          tenantId,
          sourceRef: 'raw',
          caseId,
          kind: 'thing',
          key: 'p',
          origin: 'asserted',
          assertedBy: 'Mette',
          confidence: 1,
          evidence: [],
          at: T0,
        }),
      ),
      /graph_nodes_kind/,
    );
  });

  it('an edge joins the kinds its kind joins, on one case, and a contradiction joins one subject', async () => {
    const activity = await inTenant((db) =>
      assertFact(db, {
        ...base(),
        kind: 'activity',
        key: 'activity:newsletter',
        attributes: { name: 'Newsletter' },
        origin: 'asserted',
        assertedBy: 'Mette',
        sourceRef: 'person:mette',
      }),
    );
    const purpose = await inTenant((db) =>
      assertFact(db, {
        ...base(),
        kind: 'purpose',
        key: 'purpose:marketing',
        attributes: { name: 'Marketing' },
        origin: 'asserted',
        assertedBy: 'Mette',
        sourceRef: 'person:mette',
      }),
    );
    const g = await inTenant((db) => graphOf(db, caseId));
    const google = g.nodes.find((n) => n.key === 'vendor:google')!;
    const edge = await inTenant((db) =>
      addEdge(db, {
        ...base(),
        kind: 'has_purpose',
        from: activity.node.id,
        to: purpose.node.id,
        origin: 'asserted',
        assertedBy: 'Mette',
        sourceRef: 'person:mette',
      }),
    );
    expect(edge).toMatchObject({ kind: 'has_purpose', origin: 'asserted', assertedBy: 'Mette' });
    await inTenant((db) =>
      addEdge(db, {
        ...base(),
        kind: 'shared_with',
        from: activity.node.id,
        to: google.id,
        origin: 'derived',
        sourceRef: 'scanner:dns',
        evidence: [evidenceRef],
      }),
    );
    // Wrong ends.
    await failsWith(
      inTenant((db) =>
        addEdge(db, {
          ...base(),
          kind: 'has_purpose',
          from: google.id,
          to: purpose.node.id,
          origin: 'asserted',
          assertedBy: 'Mette',
          sourceRef: 'x',
        }),
      ),
      /starts at a activity, not a vendor/,
    );
    // A contradiction between different subjects is refused.
    await failsWith(
      inTenant((db) =>
        addEdge(db, {
          ...base(),
          kind: 'contradicts',
          from: activity.node.id,
          to: purpose.node.id,
          origin: 'derived',
          sourceRef: 'x',
          evidence: [evidenceRef],
        }),
      ),
      /joins two statements about one subject/,
    );
    // The edge-kind table is the contract's, and every kind is covered.
    expect(Object.keys(GRAPH_EDGE_ENDS).sort()).toEqual(
      [
        'carries_risk',
        'contradicts',
        'has_purpose',
        'mitigated_by',
        'processes',
        'rests_on',
        'shared_with',
        'supersedes',
        'transfers_via',
      ].sort(),
    );
  });

  it('derived, asserted and answered facts are told apart, and a contradiction is kept and surfaced, never resolved on its own', async () => {
    const g0 = await inTenant((db) => graphOf(db, caseId));
    const activity = g0.nodes.find((n) => n.key === 'activity:newsletter')!;
    // The scanner derives a basis from the policy; the owner answers differently.
    const derived = await inTenant((db) =>
      assertFact(db, {
        ...base(),
        kind: 'legal_basis',
        key: 'basis:activity:newsletter',
        attributes: { name: 'Legitimate interest', article: '6(1)(f)' },
        origin: 'derived',
        sourceRef: 'scanner:policy',
        evidence: [evidenceRef],
        confidence: 0.6,
      }),
    );
    expect(derived.contradictions).toEqual([]);
    const answered = await inTenant((db) =>
      assertFact(db, {
        ...base(),
        at: later(5),
        kind: 'legal_basis',
        key: 'basis:activity:newsletter',
        attributes: { name: 'Consent', article: '6(1)(a)' },
        origin: 'answered',
        answerId: 'Q7',
        sourceRef: 'answer:Q7',
        confidence: 1,
      }),
    );
    expect(answered.contradictions).toHaveLength(1);
    expect(answered.contradictions[0]).toMatchObject({
      kind: 'contradicts',
      from: answered.node.id,
      to: derived.node.id,
      attributes: { fields: ['article', 'name'] },
    });
    for (const [node, edge] of [
      [derived.node, 'rests_on'],
      [answered.node, 'rests_on'],
    ] as const) {
      await inTenant((db) =>
        addEdge(db, {
          ...base(),
          kind: edge,
          from: activity.id,
          to: node.id,
          origin: node.origin,
          sourceRef: node.sourceRef,
          evidence: node.evidence,
          ...(node.assertedBy ? { assertedBy: node.assertedBy } : {}),
          ...(node.answerId ? { answerId: node.answerId } : {}),
        }),
      );
    }
    // Both statements stand; the origins say which is which.
    const g = await inTenant((db) => graphOf(db, caseId));
    const bases = g.nodes.filter((n) => n.kind === 'legal_basis');
    expect(bases.map((b) => b.origin).sort()).toEqual(['answered', 'derived']);
    expect(bases.every((b) => !b.supersededBy)).toBe(true);
    const open = await inTenant((db) => openContradictions(db, caseId));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: 'legal_basis',
      key: 'basis:activity:newsletter',
      fields: ['article', 'name'],
    });
    expect(open[0]!.resolved).toBeUndefined();

    // The register shows the row with its contradiction counted, as a draft.
    const before = await inTenant((db) => registerProjection(db, caseId));
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      key: 'activity:newsletter',
      name: 'Newsletter',
      purposes: ['Marketing'],
      recipients: [{ name: 'Google Workspace', country: 'IE' }],
      legalBases: expect.arrayContaining(['Consent', 'Legitimate interest']),
      contradictions: 1,
      draft: true,
      origin: 'derived',
    });
    expect(before[0]!.confidence).toBe(0.6);
    expect(before[0]!.evidence.map((e) => e.evidenceId)).toEqual([evidenceRef.evidenceId]);

    // A person decides. The loser is superseded, the decision is on the edge, and
    // nothing was deleted.
    const decided = await inTenant((db) =>
      resolveContradiction(db, {
        caseId,
        edgeId: open[0]!.edgeId,
        keep: answered.node.id,
        by: 'Mette',
        at: later(10),
      }),
    );
    expect(decided.resolved).toEqual({
      kept: answered.node.id,
      by: 'Mette',
      at: later(10).toISOString(),
    });
    expect(await inTenant((db) => openContradictions(db, caseId))).toEqual([]);
    expect(await inTenant((db) => contradictions(db, caseId))).toHaveLength(1);
    const after = await inTenant((db) => graphOf(db, caseId));
    expect(after.nodes.find((n) => n.id === derived.node.id)?.supersededBy).toBe(answered.node.id);
    expect(after.edges.some((e) => e.kind === 'supersedes' && e.from === answered.node.id)).toBe(
      true,
    );
    expect(after.nodes.length).toBe(g.nodes.length);
    const projected = await inTenant((db) => registerProjection(db, caseId));
    expect(projected[0]).toMatchObject({ legalBases: ['Consent'], contradictions: 0 });
    // Still a draft: the activity and the purpose were asserted, not answered.
    expect(projected[0]!.draft).toBe(true);
    expect(projected[0]!.origin).toBe('derived');
  });

  it('the register is a pure projection: change the graph and the row changes, and no register row is stored', async () => {
    const g = await inTenant((db) => graphOf(db, caseId));
    const activity = g.nodes.find((n) => n.key === 'activity:newsletter')!;
    const category = await inTenant((db) =>
      assertFact(db, {
        ...base(),
        kind: 'data_category',
        key: 'category:email',
        attributes: { name: 'Email address' },
        origin: 'answered',
        answerId: 'Q2',
        sourceRef: 'answer:Q2',
        confidence: 1,
      }),
    );
    await inTenant((db) =>
      addEdge(db, {
        ...base(),
        kind: 'processes',
        from: activity.id,
        to: category.node.id,
        origin: 'answered',
        answerId: 'Q2',
        sourceRef: 'answer:Q2',
        confidence: 1,
      }),
    );
    const rows = await inTenant((db) => registerProjection(db, caseId));
    expect(rows[0]!.dataCategories).toEqual(['Email address']);
    const stored = await inTenant((db) => db.select().from(schema.processingActivities));
    expect(stored).toEqual([]);
    // The graph travels with the export.
    const exported = await exportCase(t, tenantId, caseId, { locale: 'da', now: () => later(20) });
    const bundle = JSON.parse(exported.json) as { graph: { nodes: unknown[]; edges: unknown[] } };
    expect(bundle.graph.nodes.length).toBe(
      (await inTenant((db) => graphOf(db, caseId))).nodes.length,
    );
    expect(bundle.graph.edges.length).toBeGreaterThan(0);
    expect(JSON.stringify(bundle.graph)).not.toContain('"tenantId"');
  });

  it('another tenant sees none of it', async () => {
    const other = await withTenant(t, 'someone-else', (db) => graphOf(db, caseId));
    expect(other).toEqual({ nodes: [], edges: [] });
  });
});
