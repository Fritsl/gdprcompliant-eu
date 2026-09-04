import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@gc/config';
import { sha256, type ClauseStatus, type UntrustedContent } from '@gc/contracts';
import { ModelClient, ModelOutputError, analysePolicyClauses } from '@gc/agent';
import { DISCLOSURE_ELEMENTS } from '@gc/findings';

// Clause analysis eval (S-10, T-05): twelve labelled policies. The fixtures are checked
// for consistency (every "present" quote is in its text), the pipeline is proven with a
// model that answers the labels (schema, guards, findings, undetermined), and the real
// model is measured for agreement when one is configured — at least 95% over every
// element of every policy, reported so a prompt change that moves it is visible.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIR = join(ROOT, 'fixtures', 'policies');

interface PolicyFixture {
  readonly name: string;
  readonly locale: 'en' | 'da' | 'de';
  readonly jurisdiction: 'DK' | 'DE';
  readonly text: string;
  readonly expected: Record<string, { status: ClauseStatus; quote?: string }>;
}

const fixtures: PolicyFixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as PolicyFixture);

const document = (p: PolicyFixture): UntrustedContent => ({
  trust: 'untrusted',
  source: {
    url: `https://${p.name}.test/privacy`,
    description: 'privacy policy page',
    fetchedAt: '2026-09-04T09:14:00Z',
  },
  mediaType: 'text/plain',
  hash: sha256(p.text),
  text: p.text,
});
const evidenceOf = (p: PolicyFixture) => ({
  evidenceId: `document:${sha256(p.text).slice(0, 16)}`,
  hash: sha256(p.text),
});

const config = loadConfig(
  {
    NODE_ENV: 'test',
    APP_BASE_URL: 'https://gdprcompliant.eu',
    DATABASE_URL: 'postgres://gc:gc@localhost:5432/gc',
    MODEL_BASE_URL: process.env['MODEL_BASE_URL'] ?? 'https://llm.example.eu/v1',
    MODEL_API_KEY: process.env['MODEL_API_KEY'] ?? 'sk-test',
    MODEL_CHAT: process.env['MODEL_CHAT'] ?? 'chat-model',
    MODEL_EMBEDDING: process.env['MODEL_EMBEDDING'] ?? 'embed-model',
  },
  { endpoints: [{ host: 'llm.example.eu', purpose: 'model', jurisdiction: 'DK' }] },
);
const modelConfigured = Boolean(process.env['MODEL_BASE_URL'] && process.env['MODEL_CHAT']);

// A model that answers exactly what the labels say.
function labelledModel(p: PolicyFixture, mutate: (clauses: unknown[]) => unknown[] = (c) => c) {
  const clauses = Object.entries(p.expected).map(([element, e]) => ({
    element,
    status: e.status,
    ...(e.quote ? { quote: e.quote } : {}),
  }));
  const impl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: JSON.stringify({ clauses: mutate(clauses) }) },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200 },
      ),
  );
  return new ModelClient(config, { fetch: impl });
}

describe('the labelled policies', () => {
  it('are twelve, label every element, and quote what they say is present verbatim', () => {
    expect(fixtures).toHaveLength(12);
    const ids = DISCLOSURE_ELEMENTS.map((e) => e.id);
    for (const p of fixtures) {
      expect(Object.keys(p.expected).sort(), p.name).toEqual([...ids].sort());
      for (const [id, e] of Object.entries(p.expected)) {
        if (e.status === 'present') expect(p.text.includes(e.quote!), `${p.name} ${id}`).toBe(true);
        else expect(e.quote, `${p.name} ${id}`).toBeUndefined();
      }
    }
    const statuses = fixtures.flatMap((p) => Object.values(p.expected).map((e) => e.status));
    expect(statuses.filter((s) => s === 'undetermined').length).toBeGreaterThanOrEqual(10);
    expect(statuses.filter((s) => s === 'absent').length).toBeGreaterThanOrEqual(30);
  });
});

describe('the pipeline, with a model that answers the labels', () => {
  it.each(fixtures.map((p) => [p.name, p] as const))('%s', async (_, p) => {
    const analysis = await analysePolicyClauses(labelledModel(p), {
      document: document(p),
      documentEvidence: evidenceOf(p),
      elements: DISCLOSURE_ELEMENTS,
      jurisdiction: p.jurisdiction,
      locale: p.locale,
    });
    expect(analysis.clauses.map((c) => [c.element, c.status])).toEqual(
      DISCLOSURE_ELEMENTS.map((e) => [e.id, p.expected[e.id]!.status]),
    );
    for (const c of analysis.clauses) {
      expect(c.citation.kind).toBe('provision');
      if (c.status === 'present') expect(p.text).toContain(c.quote);
    }
    const absentWithType = DISCLOSURE_ELEMENTS.filter(
      (e) => p.expected[e.id]!.status === 'absent' && e.findingTypeId !== null,
    );
    expect(analysis.drafts.map((d) => [d.typeId, d.element])).toEqual(
      absentWithType.map((e) => [e.findingTypeId, e.id]),
    );
    for (const d of analysis.drafts) expect(d.evidence).toEqual([evidenceOf(p)]);
    expect(analysis.undetermined).toEqual(
      DISCLOSURE_ELEMENTS.filter((e) => p.expected[e.id]!.status === 'undetermined').map(
        (e) => e.id,
      ),
    );
  });

  it('a quote that is not in the document is refused, and an unanswered element is undetermined', async () => {
    const p = fixtures.find((f) => f.name === 'dk-complete-webshop')!;
    const forged = labelledModel(p, (clauses) =>
      clauses.map((c) => {
        const clause = c as { element: string; status: string; quote?: string };
        return clause.element === 'retention'
          ? { ...clause, quote: 'Ordreoplysninger slettes efter 30 dage.' }
          : clause;
      }),
    );
    await expect(
      analysePolicyClauses(forged, {
        document: document(p),
        documentEvidence: evidenceOf(p),
        elements: DISCLOSURE_ELEMENTS,
        jurisdiction: 'DK',
        locale: 'da',
      }),
    ).rejects.toThrow(ModelOutputError);

    const silent = labelledModel(p, (clauses) => clauses.slice(0, 3));
    const analysis = await analysePolicyClauses(silent, {
      document: document(p),
      documentEvidence: evidenceOf(p),
      elements: DISCLOSURE_ELEMENTS,
      jurisdiction: 'DK',
      locale: 'da',
    });
    expect(analysis.undetermined).toHaveLength(DISCLOSURE_ELEMENTS.length - 3);
    expect(analysis.drafts).toEqual([]);
  });
});

describe.skipIf(!modelConfigured)('the model, measured', () => {
  it('agrees with the labels on at least 95% of element judgements', async () => {
    const client = new ModelClient(loadConfig());
    let agreed = 0;
    let total = 0;
    const misses: string[] = [];
    for (const p of fixtures) {
      const analysis = await analysePolicyClauses(client, {
        document: document(p),
        documentEvidence: evidenceOf(p),
        elements: DISCLOSURE_ELEMENTS,
        jurisdiction: p.jurisdiction,
        locale: p.locale,
      });
      for (const c of analysis.clauses) {
        total += 1;
        if (c.status === p.expected[c.element]!.status) agreed += 1;
        else
          misses.push(
            `${p.name}.${c.element}: ${c.status}, expected ${p.expected[c.element]!.status}`,
          );
      }
    }
    console.log(
      `policy clauses eval: ${agreed}/${total} agree (${((agreed / total) * 100).toFixed(1)}%)${misses.length ? `\n  ${misses.join('\n  ')}` : ''}`,
    );
    expect(agreed / total).toBeGreaterThanOrEqual(0.95);
  });
});

if (!modelConfigured) {
  console.log(
    'policy clauses eval: no MODEL_BASE_URL in the environment; the model was not measured',
  );
}
