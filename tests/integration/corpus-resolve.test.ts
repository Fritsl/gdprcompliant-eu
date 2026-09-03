import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaimSchema, parseProvisionRef, type Jurisdiction } from '@gc/contracts';
import { createTestDatabase, schema, testDatabaseUrl, withTenant, type TestDatabase } from '@gc/db';
import {
  corpusVersions,
  deterministicEmbedder,
  ingestCorpus,
  loadCorpusDocuments,
  resolveCitation,
  retrieve,
} from '@gc/corpus';

// Corpus retrieval with a jurisdiction filter (A-08): chunks in the database carry their
// identifiers; a citation resolves to exactly one row or fails; retrieval inside a
// jurisdiction never returns another country's law; a tenant can read the corpus and
// cannot write it; the corpus version travels onto the claim.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const embed = deterministicEmbedder();
const cite = (instrument: string, ref: string) => parseProvisionRef(instrument, ref);
let db: TestDatabase;

// Drizzle wraps the driver's error; the policy violation is on the cause.
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

beforeAll(async () => {
  if (!url) return;
  db = await createTestDatabase(url);
  for (const doc of loadCorpusDocuments().filter((d) => d.instrument.startsWith('TEST-'))) {
    await ingestCorpus(db, doc, embed);
  }
});

afterAll(async () => {
  await db?.drop();
});

describe.skipIf(!url)('corpus in the database', () => {
  it('every chunk carries jurisdiction, instrument, article and paragraph identifiers, at a version', async () => {
    const rows = await db.db.select().from(schema.corpusChunks);
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.tenantId).toBe('shared');
      expect(r.jurisdiction).toMatch(/^(EU|[A-Z]{2})$/);
      expect(r.key.startsWith(`${r.instrument}:${r.article}`)).toBe(true);
      expect(r.corpusVersion).toBe('2026-09-04.test');
      expect(r.embedding).toHaveLength(1024);
    }
    expect(await corpusVersions(db)).toEqual([
      { instrument: 'TEST-DK', corpusVersion: '2026-09-04.test', chunks: 2 },
      { instrument: 'TEST-REG', corpusVersion: '2026-09-04.test', chunks: 6 },
    ]);
  });

  it('ingesting the same version again replaces it rather than doubling it', async () => {
    const doc = loadCorpusDocuments().find((d) => d.instrument === 'TEST-DK')!;
    await ingestCorpus(db, doc, embed);
    const rows = await db.db.select().from(schema.corpusChunks);
    expect(rows.filter((r) => r.instrument === 'TEST-DK')).toHaveLength(2);
  });

  it('a citation resolves to exactly one paragraph or fails, with no nearest match', async () => {
    const hit = await resolveCitation(db, cite('TEST-REG', 'Art. 5(3)'), 'DK');
    expect(hit.ok && hit.chunk.text).toMatch(/^The storing of information/);
    expect(hit.ok && hit.corpusVersion).toBe('2026-09-04.test');
    const point = await resolveCitation(db, cite('TEST-REG', 'Art. 5(1)(a)'), 'DE');
    expect(point.ok && point.chunk.id).toBe('TEST-REG:5:1:a@2026-09-04.test');
    for (const ref of ['Art. 5(4)', 'Art. 5', 'Art. 6(1)', 'Art. 5(3)(b)']) {
      const miss = await resolveCitation(db, cite('TEST-REG', ref), 'DK');
      expect(!miss.ok && miss.reason, ref).toBe('no_such_paragraph');
    }
    const unknown = await resolveCitation(db, cite('GDPR', 'Art. 5(3)'), 'DK');
    expect(!unknown.ok && unknown.reason).toBe('unknown_instrument');
  });

  it('a national instrument resolves at home and fails abroad', async () => {
    expect((await resolveCitation(db, cite('TEST-DK', 'Art. 3(1)'), 'DK')).ok).toBe(true);
    const abroad = await resolveCitation(db, cite('TEST-DK', 'Art. 3(1)'), 'DE');
    expect(!abroad.ok && abroad.reason).toBe('wrong_jurisdiction');
  });

  it('retrieval inside a jurisdiction finds Union law and its own law, never another country', async () => {
    const query = 'consent before storing information in terminal equipment';
    const dk = await retrieve(db, query, embed, { jurisdiction: 'DK', k: 3 });
    expect(
      dk
        .map((r) => r.chunk.id)
        .slice(0, 2)
        .sort(),
    ).toEqual(['TEST-DK:3:1@2026-09-04.test', 'TEST-REG:5:3@2026-09-04.test']);
    expect(dk.every((r, i, a) => i === 0 || r.distance >= a[i - 1]!.distance)).toBe(true);

    const de = await retrieve(db, query, embed, { jurisdiction: 'DE', k: 8 });
    expect(de.length).toBeGreaterThan(0);
    expect(de.every((r) => r.chunk.jurisdiction === 'EU')).toBe(true);
    expect(de[0]!.chunk.id).toBe('TEST-REG:5:3@2026-09-04.test');

    // The word "Denmark" in the query does not pull Danish law into a German case.
    const named = await retrieve(db, 'complaints Denmark Danish supervisory authority', embed, {
      jurisdiction: 'DE' as Jurisdiction,
    });
    expect(named.some((r) => r.chunk.instrument === 'TEST-DK')).toBe(false);
  });

  it('a tenant reads the corpus through its own transaction and cannot write to it', async () => {
    const seen = await withTenant(db, 't-someone', (tx) =>
      tx.select({ id: schema.corpusChunks.id }).from(schema.corpusChunks),
    );
    expect(seen).toHaveLength(8);
    await failsWith(
      withTenant(db, 't-someone', (tx) =>
        tx.insert(schema.corpusChunks).values({
          id: 'X:1@2026-09-04',
          tenantId: 'shared',
          sourceRef: 'test',
          corpusVersion: '2026-09-04',
          instrument: 'X',
          jurisdiction: 'EU',
          kind: 'article',
          key: 'X:1',
          article: '1',
          text: 'planted',
          hash: 'a'.repeat(64),
          sourceUrl: 'https://example.invalid/x',
          retrievedAt: new Date(),
        }),
      ),
      /row-level security policy/,
    );
    await failsWith(
      withTenant(db, 't-someone', (tx) => tx.update(schema.corpusChunks).set({ text: 'tampered' })),
      /row-level security policy/,
    );
  });

  it('the corpus version a citation resolved against is recorded on the claim', async () => {
    const citation = cite('TEST-REG', 'Art. 5(3)');
    const resolved = await resolveCitation(db, citation, 'DK');
    if (!resolved.ok) throw new Error(resolved.detail);
    const claim = ClaimSchema.parse({
      id: 'claim-1',
      caseId: 'DK-26-0M4K',
      kind: 'legal',
      statement: 'Storing on terminal equipment needs consent.',
      evidence: [
        {
          evidenceId: 'ev-1',
          hash: 'b'.repeat(64),
          quote: 'Set-Cookie: _ga=…',
        },
      ],
      citations: [citation],
      jurisdiction: 'DK',
      corpusVersion: resolved.corpusVersion,
      producedBy: { worker: 'legal_mapper' },
      at: '2026-09-04T09:14:00Z',
    });
    expect(claim.corpusVersion).toBe('2026-09-04.test');
    expect(ClaimSchema.safeParse({ ...claim, corpusVersion: undefined }).success).toBe(false);
  });
});
