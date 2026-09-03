import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseProvisionRef, sha256, type Claim } from '@gc/contracts';
import {
  caseTimeline,
  createTestDatabase,
  deleteCase,
  openCase,
  schema,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import {
  createVerifier,
  deterministicEmbedder,
  ingestCorpus,
  loadCorpusDocuments,
  markReviewed,
  reviewQueue,
} from '@gc/corpus';

// The verifier against the database (A-07): evidence read from the tenant, citations
// from corpus_chunks, every verdict written, a rejection on the timeline and in the
// review queue, verdicts confined to their tenant, and gone with the case.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const NOW = new Date('2026-09-04T09:14:00Z');
let db: TestDatabase;
let tenantId: string;
let caseId: string;
const body = 'Set-Cookie: _ga=GA1.2.1; Expires=Thu, 01 Jan 2028 00:00:00 GMT';
const hash = sha256(body);
const evidenceId = `header:${hash.slice(0, 16)}`;

beforeAll(async () => {
  if (!url) return;
  db = await createTestDatabase(url);
  const doc = loadCorpusDocuments().find((d) => d.instrument === 'TEST-REG')!;
  await ingestCorpus(db, doc, deterministicEmbedder());
  const opened = await openCase(db, {
    company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
    jurisdiction: 'DK',
    locale: 'da',
    now: () => NOW,
  });
  tenantId = opened.tenantId;
  caseId = opened.caseId;
  await withTenant(db, tenantId, (tx) =>
    tx.insert(schema.evidence).values({
      id: evidenceId,
      tenantId,
      sourceRef: 'scanner:scan-1',
      caseId,
      scanId: 'scan-1',
      kind: 'header',
      capturedAt: NOW,
      observed: { url: 'https://eksempelbutik.dk/', pass: 'B' },
      body,
      hash,
    }),
  );
});

afterAll(async () => {
  await db?.drop();
});

const claim = (over: Partial<Claim> = {}): Claim => ({
  id: 'claim-1',
  caseId,
  kind: 'legal',
  statement: 'A Google Analytics cookie is set before consent.',
  evidence: [{ evidenceId, hash, quote: 'Set-Cookie: _ga=' }],
  citations: [{ ...parseProvisionRef('TEST-REG', 'Art. 5(3)')!, quote: 'has given consent' }],
  jurisdiction: 'DK',
  corpusVersion: '2026-09-04.test',
  producedBy: { worker: 'legal_mapper' },
  at: NOW.toISOString(),
  ...over,
});

describe.skipIf(!url)('the verifier against the database', () => {
  it('accepts a claim whose evidence and citation are in the database, and records the verdict', async () => {
    const verifier = createVerifier(db, { now: () => NOW });
    const v = await verifier.verify(tenantId, claim());
    expect(v.verdict).toBe('accepted');
    const rows = await withTenant(db, tenantId, (tx) => tx.select().from(schema.claimVerdicts));
    expect(rows.map((r) => [r.claimId, r.verdict, r.reason])).toEqual([
      ['claim-1', 'accepted', null],
    ]);
    expect(await reviewQueue(db)).toEqual([]);
  });

  it('rejects a fabricated quote, puts the reason on the timeline and in the review queue, and the queue clears when reviewed', async () => {
    const verifier = createVerifier(db, {
      now: () => new Date(NOW.getTime() + 1000),
      review: async () => ({ supported: true, reason: 'yes' }),
    });
    const v = await verifier.verify(
      tenantId,
      claim({
        id: 'claim-2',
        evidence: [{ evidenceId, hash, quote: 'Set-Cookie: _ga=; Max-Age=0' }],
      }),
    );
    expect(v.verdict).toBe('rejected');
    expect(v.checks.some((c) => c.name === 'model_review')).toBe(false);

    const timeline = await withTenant(db, tenantId, (tx) => caseTimeline(tx, caseId));
    const rejected = timeline.filter((e) => e.type === 'claim_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.payload).toEqual({ claimId: 'claim-2', reason: v.reason });
    expect(rejected[0]!.actor).toEqual({ kind: 'agent', name: 'verifier' });

    const queue = await reviewQueue(db);
    expect(queue.map((q) => [q.claimId, q.tenantId, q.reason])).toEqual([
      ['claim-2', tenantId, v.reason],
    ]);
    expect(await markReviewed(db, tenantId, queue[0]!.id, 'ops@gdprcompliant.eu')).toBe(true);
    expect(await markReviewed(db, tenantId, queue[0]!.id, 'ops@gdprcompliant.eu')).toBe(false);
    expect(await reviewQueue(db)).toEqual([]);
  });

  it('a citation that is not in the corpus, or an evidence row that is not there, rejects', async () => {
    const verifier = createVerifier(db, { now: () => new Date(NOW.getTime() + 2000) });
    const noLaw = await verifier.verify(
      tenantId,
      claim({ id: 'claim-3', citations: [parseProvisionRef('TEST-REG', 'Art. 5(4)')!] }),
    );
    expect(noLaw.reason).toMatch(/TEST-REG:5:4 does not resolve in DK/);
    const noEvidence = await verifier.verify(
      tenantId,
      claim({ id: 'claim-4', evidence: [{ evidenceId: 'header:0000000000000000', hash }] }),
    );
    expect(noEvidence.reason).toMatch(/is not stored/);
  });

  it('another tenant sees no verdicts, and cannot read the evidence the claim points at', async () => {
    const other = await withTenant(db, 't-other', (tx) => tx.select().from(schema.claimVerdicts));
    expect(other).toEqual([]);
    const verifier = createVerifier(db, { now: () => new Date(NOW.getTime() + 3000) });
    const opened = await openCase(db, {
      company: { domain: 'andenbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => NOW,
    });
    // The other tenant's claim points at this tenant's evidence: unreadable there, so unproven.
    const v = await verifier.verify(
      opened.tenantId,
      claim({ id: 'claim-5', caseId: opened.caseId }),
    );
    expect(v.verdict).toBe('rejected');
    expect(v.reason).toMatch(/is not stored/);
    await deleteCase(db, opened.tenantId, opened.caseId, {
      requestedBy: 'operator',
      reason: 'done',
      now: () => NOW,
    });
  });

  it('verdicts go with the case', async () => {
    const before = await withTenant(db, tenantId, (tx) => tx.select().from(schema.claimVerdicts));
    expect(before.length).toBeGreaterThan(0);
    await deleteCase(db, tenantId, caseId, {
      requestedBy: 'owner',
      reason: 'test',
      now: () => NOW,
    });
    const after = await withTenant(db, tenantId, (tx) => tx.select().from(schema.claimVerdicts));
    expect(after).toEqual([]);
  });
});
