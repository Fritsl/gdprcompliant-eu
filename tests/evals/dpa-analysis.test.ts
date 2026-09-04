import { recordEvalResult } from './record.js';
import { thresholdOf } from './sets.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@gc/config';
import {
  AGREEMENT_FINDINGS,
  AGREEMENT_SPECIFICS,
  parseProvisionRef,
  sha256,
  type AgreementDiscovery,
  type AgreementSpecific,
  type AgreementVerdict,
  type ClauseStatus,
  type Evidence,
  type SpecificStatus,
  type UntrustedContent,
} from '@gc/contracts';
import {
  ModelClient,
  ModelOutputError,
  agreementClaims,
  analyseAgreement,
  verifyClaim,
  type VerifierDeps,
} from '@gc/agent';
import { documentChunks, loadCorpusDocuments, resolveInChunks } from '@gc/corpus';
import { AGREEMENT_ELEMENTS } from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';
import { agreementDraft } from '@gc/scanner';

// Processing agreement eval (D-06, T-05): ten labelled agreements, in three languages,
// modelled on the ones small companies actually sign. The fixtures are checked for
// consistency (every "present" quote is in its text; all three verdicts occur), the
// pipeline is proven with a model that answers the labels (statuses, the three specific
// checks, the verdict, the finding, and every claim through the verifier gate), the
// three shortcomings are shown to be three findings with three remedies, and the real
// model is measured for agreement when one is configured: at least 95% over every
// element of every agreement, reported so a prompt change that moves it is visible.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIR = join(ROOT, 'fixtures', 'agreements');
const NOW = '2026-09-04T09:14:00Z';
const CASE = 'DK-26-0M4K';

interface AgreementFixture {
  readonly name: string;
  readonly locale: 'en' | 'da' | 'de';
  readonly jurisdiction: 'DK' | 'DE';
  readonly vendor: { host: string; name: string };
  readonly text: string;
  readonly expected: Record<string, { status: ClauseStatus; quote?: string }>;
  readonly expectedSpecifics: Record<AgreementSpecific, { status: SpecificStatus; hours?: number }>;
  readonly expectedVerdict: AgreementVerdict;
  readonly reasoning: string;
}

const fixtures: AgreementFixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as AgreementFixture);

const chunks = loadCorpusDocuments().flatMap(documentChunks);
const catalogue = loadCatalogue();

const stored = (p: AgreementFixture): Evidence => ({
  id: `document:${sha256(p.text).slice(0, 16)}`,
  tenantId: 't-1',
  caseId: CASE,
  kind: 'document',
  capturedAt: NOW,
  source: { url: `https://${p.vendor.host}/legal/dpa`, host: p.vendor.host },
  body: p.text,
  hash: sha256(p.text),
});
const document = (p: AgreementFixture): UntrustedContent => ({
  trust: 'untrusted',
  source: {
    url: `https://${p.vendor.host}/legal/dpa`,
    description: `processing agreement of ${p.vendor.name}`,
    fetchedAt: NOW,
  },
  mediaType: 'text/plain',
  hash: sha256(p.text),
  text: p.text,
});
const evidenceOf = (p: AgreementFixture) => ({ evidenceId: stored(p).id, hash: stored(p).hash });
const input = (p: AgreementFixture) => ({
  document: document(p),
  documentEvidence: evidenceOf(p),
  elements: AGREEMENT_ELEMENTS,
  jurisdiction: p.jurisdiction,
  locale: p.locale,
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
function labelledModel(
  p: AgreementFixture,
  mutate: (clauses: unknown[]) => unknown[] = (c) => c,
): ModelClient {
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

// The gate, over the corpus and the stored fixture documents.
const deps: VerifierDeps = {
  evidence: async (_, ref) => fixtures.map(stored).find((e) => e.id === ref.evidenceId),
  resolve: async (c, j, v) => resolveInChunks(chunks, c, j, v ? { corpusVersion: v } : {}),
  now: () => new Date(NOW),
};

describe('the labelled agreements', () => {
  it('are twenty, label every element, quote what they say is present verbatim, and reach every verdict', () => {
    expect(fixtures).toHaveLength(20);
    const ids = AGREEMENT_ELEMENTS.map((e) => e.id);
    for (const p of fixtures) {
      expect(Object.keys(p.expected).sort(), p.name).toEqual([...ids].sort());
      for (const [id, e] of Object.entries(p.expected)) {
        if (e.status === 'present') expect(p.text.includes(e.quote!), `${p.name} ${id}`).toBe(true);
        else expect(e.quote, `${p.name} ${id}`).toBeUndefined();
      }
      expect(Object.keys(p.expectedSpecifics).sort()).toEqual([...AGREEMENT_SPECIFICS].sort());
      expect(p.reasoning.length).toBeGreaterThan(80);
    }
    const verdicts = fixtures.map((p) => p.expectedVerdict);
    expect(verdicts.filter((v) => v === 'adequate').length).toBeGreaterThanOrEqual(2);
    expect(verdicts.filter((v) => v === 'inadequate').length).toBeGreaterThanOrEqual(5);
    expect(verdicts.filter((v) => v === 'undetermined').length).toBeGreaterThanOrEqual(1);
    const statuses = fixtures.flatMap((p) => Object.values(p.expected).map((e) => e.status));
    expect(statuses.filter((s) => s === 'absent').length).toBeGreaterThanOrEqual(12);
    expect(statuses.filter((s) => s === 'undetermined').length).toBeGreaterThanOrEqual(5);
    // Every specific check fails somewhere and passes somewhere.
    for (const s of AGREEMENT_SPECIFICS) {
      const seen = new Set(fixtures.map((p) => p.expectedSpecifics[s].status));
      expect(seen.has('met'), s).toBe(true);
      expect(seen.has('not_met'), s).toBe(true);
    }
    expect(new Set(fixtures.map((p) => p.locale))).toEqual(new Set(['en', 'da', 'de']));
  });
});

describe('the pipeline, with a model that answers the labels', () => {
  const scored: boolean[] = [];
  afterAll(() => {
    recordEvalResult({
      set: 'dpa-analysis',
      mode: 'pipeline',
      agreed: scored.filter(Boolean).length,
      total: fixtures.length,
      threshold: thresholdOf('dpa-analysis'),
    });
  });
  it.each(fixtures.map((p) => [p.name, p] as const))('%s', async (_, p) => {
    scored.push(false);
    const analysis = await analyseAgreement(labelledModel(p), input(p));

    // 1. Each element, individually, with its quote or its explicit absence.
    expect(analysis.clauses.map((c) => [c.element, c.status])).toEqual(
      AGREEMENT_ELEMENTS.map((e) => [e.id, p.expected[e.id]!.status]),
    );
    for (const c of analysis.clauses) {
      expect(c.citation.kind).toBe('provision');
      if (c.status === 'present') expect(c.quote).toBe(p.expected[c.element]!.quote);
      else expect(c.quote).toBeUndefined();
    }
    expect(analysis.missing).toEqual(
      AGREEMENT_ELEMENTS.filter((e) => p.expected[e.id]!.status === 'absent').map((e) => e.id),
    );

    // 2. The three specific checks, read from the clause in code.
    expect(analysis.specifics).toHaveLength(AGREEMENT_SPECIFICS.length);
    for (const s of analysis.specifics) {
      const want = p.expectedSpecifics[s.specific];
      expect(s.status, `${p.name} ${s.specific}: ${s.detail}`).toBe(want.status);
      if (want.hours !== undefined) expect(s.hours, `${p.name} ${s.specific}`).toBe(want.hours);
      expect(s.detail.length).toBeGreaterThan(10);
    }

    // 3. The verdict, and the finding it raises or does not.
    expect(analysis.verdict).toBe(p.expectedVerdict);
    if (p.expectedVerdict === 'inadequate') {
      expect(analysis.drafts).toHaveLength(1);
      const draft = analysis.drafts[0]!;
      expect(draft.typeId).toBe(AGREEMENT_FINDINGS.inadequate);
      expect(draft.evidence).toEqual([evidenceOf(p)]);
      const failed = analysis.specifics.filter((s) => s.status === 'not_met').map((s) => s.element);
      expect(draft.elements).toEqual([...new Set([...analysis.missing, ...failed])]);
    } else {
      expect(analysis.drafts).toEqual([]);
    }

    // 4. Every claim through the gate: quotes are in the stored document, every legal
    //    claim cites a provision, and every citation resolves in the case's jurisdiction.
    const claims = agreementClaims(analysis, {
      caseId: CASE,
      documentEvidence: evidenceOf(p),
      elements: AGREEMENT_ELEMENTS,
      corpusVersion: '2026-09-03',
      taskId: 'task-1',
      at: new Date(NOW),
    });
    const present = analysis.clauses.filter((c) => c.status === 'present').length;
    expect(claims.filter((c) => c.kind === 'observation')).toHaveLength(present);
    const legal = claims.filter((c) => c.kind === 'legal');
    expect(legal.length).toBeGreaterThanOrEqual(analysis.missing.length);
    for (const c of legal) {
      expect(c.citations.length).toBeGreaterThanOrEqual(1);
      expect(c.jurisdiction).toBe(p.jurisdiction);
    }
    for (const c of claims) {
      const v = await verifyClaim(c, deps);
      expect(v.verdict, `${p.name}: ${c.statement.slice(0, 80)} — ${v.reason ?? ''}`).toBe(
        'accepted',
      );
    }
    scored[scored.length - 1] = true;
  });

  it('a quote that is not in the document is refused, and an unanswered element is undetermined', async () => {
    const p = fixtures.find((f) => f.name === 'en-mail-provider-complete')!;
    const forged = labelledModel(p, (clauses) =>
      clauses.map((c) => {
        const clause = c as { element: string; status: string; quote?: string };
        return clause.element === 'breach_notification'
          ? { ...clause, quote: 'The Processor notifies the Controller within 4 hours.' }
          : clause;
      }),
    );
    await expect(analyseAgreement(forged, input(p))).rejects.toThrow(ModelOutputError);

    const silent = labelledModel(p, (clauses) => clauses.slice(0, 5));
    const analysis = await analyseAgreement(silent, input(p));
    expect(analysis.undetermined).toHaveLength(AGREEMENT_ELEMENTS.length - 5);
    expect(analysis.verdict).toBe('undetermined');
    expect(analysis.drafts).toEqual([]);
  });

  it('a legal claim whose citation does not resolve is stopped at the gate', async () => {
    const p = fixtures.find((f) => f.name === 'da-webbureau-mangler-indsigelse')!;
    const analysis = await analyseAgreement(labelledModel(p), input(p));
    const [legal] = agreementClaims(analysis, {
      caseId: CASE,
      documentEvidence: evidenceOf(p),
      elements: AGREEMENT_ELEMENTS,
      corpusVersion: '2026-09-03',
      taskId: 'task-1',
      at: new Date(NOW),
    }).filter((c) => c.kind === 'legal');
    const invented = { ...legal!, citations: [parseProvisionRef('GDPR', 'Art. 28(11)')!] };
    const v = await verifyClaim(invented, deps);
    expect(v.verdict).toBe('rejected');
    expect(v.checks.find((c) => c.name === 'citation_resolves')?.passed).toBe(false);
  });
});

describe('the three shortcomings', () => {
  const discovery = (outcome: AgreementDiscovery['outcome']): AgreementDiscovery => ({
    vendor: { host: 'sendmore.test', name: 'Sendmore' },
    startedAt: NOW,
    fetched: 3,
    outcome,
    trail:
      outcome === 'unfindable'
        ? [{ url: 'https://sendmore.test/dpa', status: 404, reason: 'answered 404' }]
        : [],
    summary: `outcome ${outcome}`,
    evidence: [{ evidenceId: 'document:0123456789abcdef', hash: 'a'.repeat(64) }],
  });

  it('are three findings with three different remedies in every jurisdiction', async () => {
    const none = agreementDraft({ discovery: discovery('none'), evidence: [] }, 'eksempelbutik.dk');
    const unfindable = agreementDraft(
      { discovery: discovery('unfindable'), evidence: [] },
      'eksempelbutik.dk',
    );
    const p = fixtures.find((f) => f.name === 'en-saas-terms-only')!;
    const inadequate = (await analyseAgreement(labelledModel(p), input(p))).drafts[0]!;
    expect(none?.typeId).toBe('DPA-01');
    expect(unfindable?.typeId).toBe('DPA-02');
    expect(inadequate.typeId).toBe('DPA-03');
    expect(unfindable?.summary).toContain('answered 404');
    for (const jurisdiction of ['DK', 'DE'] as const) {
      const remedies = ['DPA-01', 'DPA-02', 'DPA-03'].map(
        (id) => catalogue.forFinding(id, jurisdiction)[0]?.remedy,
      );
      expect(remedies.map((r) => r?.id)).toEqual([
        'dpa-01-processing-agreement',
        'dpa-02-obtain-the-agreement',
        'dpa-03-close-the-gaps',
      ]);
      expect(new Set(remedies.map((r) => r?.kind)).size).toBeGreaterThanOrEqual(2);
    }
  });

  it('found raises nothing until the document is read, and unreachable raises nothing at all', () => {
    expect(
      agreementDraft(
        {
          discovery: {
            ...discovery('found'),
            document: {
              url: 'https://sendmore.test/dpa',
              finalUrl: 'https://sendmore.test/dpa',
              words: 800,
              foundBy: 'link',
              evidence: { evidenceId: 'document:0123456789abcdef', hash: 'a'.repeat(64) },
            },
          },
          evidence: [],
        },
        'eksempelbutik.dk',
      ),
    ).toBeUndefined();
    expect(
      agreementDraft(
        { discovery: { ...discovery('unreachable'), evidence: [] }, evidence: [] },
        'eksempelbutik.dk',
      ),
    ).toBeUndefined();
  });
});

describe.skipIf(!modelConfigured)('the model, measured', () => {
  it('agrees with the labels on at least 95% of element judgements', async () => {
    const client = new ModelClient(loadConfig());
    let agreed = 0;
    let total = 0;
    let verdicts = 0;
    const misses: string[] = [];
    for (const p of fixtures) {
      const analysis = await analyseAgreement(client, input(p));
      for (const c of analysis.clauses) {
        total += 1;
        if (c.status === p.expected[c.element]!.status) agreed += 1;
        else
          misses.push(
            `${p.name}.${c.element}: ${c.status}, expected ${p.expected[c.element]!.status}`,
          );
      }
      if (analysis.verdict === p.expectedVerdict) verdicts += 1;
      else misses.push(`${p.name}: verdict ${analysis.verdict}, expected ${p.expectedVerdict}`);
    }
    recordEvalResult({
      set: 'dpa-analysis',
      mode: 'model',
      agreed,
      total,
      threshold: thresholdOf('dpa-analysis'),
      misses: [...misses, `${verdicts}/${fixtures.length} verdicts agree`],
    });
    expect(agreed / total).toBeGreaterThanOrEqual(thresholdOf('dpa-analysis'));
  });
});

if (!modelConfigured) {
  console.log(
    'dpa analysis eval: no MODEL_BASE_URL in the environment; the model was not measured',
  );
}
