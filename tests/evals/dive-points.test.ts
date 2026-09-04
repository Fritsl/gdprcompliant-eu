import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DIVE_MAX_CHARS,
  QUOTED,
  advise,
  caseFacts,
  diveQuestion,
  diveable,
  stripFragment,
  tellMeMore,
  type AdviseInput,
  type ModelClient,
} from '@gc/agent';
import {
  DiveOriginSchema,
  parseProvisionRef,
  type Advice,
  type CorpusChunk,
  type DiveOrigin,
  type Jurisdiction,
  type Locale,
  type ModelInput,
  type ModelOutput,
} from '@gc/contracts';
import {
  advisorStack,
  askAdvisor,
  corpusChunks,
  deterministicEmbedder,
  resolveInChunks,
} from '@gc/corpus';
import {
  adviceOf,
  advisorCatalogue,
  caseTimeline,
  createTestDatabase,
  openCase,
  testDatabaseUrl,
  threadOf,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { bannedClaims, loadClaimVocabulary } from '@gc/i18n';
import { CASES, lexical, selects, type CaseKey } from './advisor-cases.js';
import { recordEvalResult } from './record.js';
import { ROOT, thresholdOf } from './sets.js';

// Dive points (V-05). Any element opens a conversation already scoped to it: the
// fragment is stripped of markdown, capped at 300 characters and prefixed with the
// localised "Tell me more about this:"; elements with nothing to expand, or that already
// offer a next action, get no dive point; turn zero carries the fragment as fenced
// quoted data, the case as facts, and law retrieved on the fragment; after that it is an
// ordinary conversation and a further dive appends. Every dive is a timeline event.

type FragmentScenario = {
  readonly name: string;
  readonly kind: 'fragment';
  readonly locale: Locale;
  readonly input: string;
  readonly hasAction?: boolean;
  readonly reasoning: string;
  readonly expect: { readonly text?: string; readonly length?: number; readonly diveable: boolean };
};
type SeedScenario = {
  readonly name: string;
  readonly kind: 'seed';
  readonly case: CaseKey;
  readonly origin: DiveOrigin;
  readonly fragment: string;
  readonly reasoning: string;
  readonly expect: {
    readonly question: string;
    readonly retrievalQuery: string;
    readonly caseSays: readonly string[];
    readonly law: readonly string[];
  };
};
type Scenario = FragmentScenario | SeedScenario;

const fixture = JSON.parse(
  readFileSync(join(ROOT, 'fixtures', 'advisor', 'dives.json'), 'utf8'),
) as { scenarios: Scenario[] };
const scenarios = fixture.scenarios;
const fragments = scenarios.filter((s): s is FragmentScenario => s.kind === 'fragment');
const seeds = scenarios.filter((s): s is SeedScenario => s.kind === 'seed');
const vocab = loadClaimVocabulary();
const chunks = corpusChunks();
const NOW = () => new Date('2026-09-04T10:00:00Z');

const refOf = (ref: string) => {
  const [instrument, ...rest] = ref.split(' ');
  return parseProvisionRef(instrument!, rest.join(' '))!;
};
const chunkFor = (ref: string, jurisdiction: Jurisdiction): CorpusChunk => {
  const r = resolveInChunks(chunks, refOf(ref), jurisdiction);
  if (!r.ok || !('chunk' in r)) throw new Error(`label ${ref} does not resolve`);
  return r.chunk;
};

// The passages the label names, plus the nearest by words, and a note of the query.
const labelledRetrieval = (s: SeedScenario, queries: string[]): AdviseInput['retrieve'] => {
  return async (query, jurisdiction, k) => {
    queries.push(query);
    const named = s.expect.law.map((ref) => ({ chunk: chunkFor(ref, jurisdiction), distance: 0 }));
    const near = await lexical(query, jurisdiction, k);
    const seen = new Set(named.map((n) => n.chunk.id));
    return [...named, ...near.filter((n) => !seen.has(n.chunk.id))].slice(
      0,
      Math.max(k, named.length),
    );
  };
};

// A model that answers from the labels and nothing else.
const stubFor = (
  s: SeedScenario,
  seen: ModelInput<'advise'>[] = [],
): Pick<ModelClient, 'call'> => ({
  call: (async (request: { input: unknown }): Promise<ModelOutput<'advise'>> => {
    const input = request.input as ModelInput<'advise'>;
    seen.push(input);
    const caseSays = (input.facts ?? []).filter((f) =>
      s.expect.caseSays.some((sel) => selects(sel, f.label)),
    );
    const lawSays = (input.passages ?? [])
      .filter((p) => s.expect.law.includes(p.ref))
      .map((p) => ({ key: p.key, quote: p.text.split(/\s+/).slice(0, 8).join(' ') }));
    return {
      answer: `Sagen viser ${caseSays.map((c) => c.label).join(', ')}.`,
      caseSays,
      lawSays,
      refuse: false,
    };
  }) as ModelClient['call'],
});

async function seedTurnZero(
  s: SeedScenario,
  client: Pick<ModelClient, 'call'>,
  queries: string[] = [],
): Promise<Advice> {
  const c = CASES[s.case];
  const q = diveQuestion(c.locale, s.fragment);
  const fragment = stripFragment(s.fragment);
  return advise(client, {
    question: q.prefix,
    quoted: { text: fragment, source: `${s.origin.kind} ${s.origin.ref}` },
    locale: c.locale,
    jurisdiction: c.jurisdiction,
    facts: caseFacts(c.record),
    retrieve: labelledRetrieval(s, queries),
    catalogue: advisorCatalogue(c.locale),
    thread: { id: `thread:${s.name}`, turn: 0 },
    dive: { origin: s.origin, fragment },
    now: NOW,
  });
}

function fragmentDisagreement(s: FragmentScenario): string | undefined {
  const text = stripFragment(s.input);
  if (s.expect.text !== undefined && text !== s.expect.text)
    return `${s.name}: stripped to ${JSON.stringify(text)}`;
  if (s.expect.length !== undefined && text.length !== s.expect.length)
    return `${s.name}: ${text.length} characters, expected ${s.expect.length}`;
  const gate = diveable(s.input, s.hasAction ? { hasAction: true } : {});
  if (gate !== s.expect.diveable)
    return `${s.name}: diveable ${gate}, expected ${s.expect.diveable}`;
  return undefined;
}

function seedDisagreement(
  s: SeedScenario,
  a: Advice,
  queries: readonly string[],
): string | undefined {
  if (a.question !== s.expect.question)
    return `${s.name}: turn zero reads ${JSON.stringify(a.question)}`;
  if (queries[0] !== s.expect.retrievalQuery)
    return `${s.name}: retrieval ran on ${JSON.stringify(queries[0])}, not the fragment`;
  if (a.refused) return `${s.name}: refused: ${a.refused.reason}`;
  for (const sel of s.expect.caseSays)
    if (!a.caseSays.some((f) => selects(sel, f.label)))
      return `${s.name}: ${sel} is not among what the case says`;
  const cited = new Set(
    a.lawSays.map((l) => (l.citation.kind === 'provision' ? l.citation.ref : l.key)),
  );
  for (const r of s.expect.law)
    if (!cited.has(refOf(r).ref)) return `${s.name}: ${refOf(r).ref} is not cited`;
  if (bannedClaims(a.answer, a.locale, vocab).length > 0)
    return `${s.name}: a verdict word in the answer`;
  if (a.dive?.origin.kind !== s.origin.kind || a.thread?.turn !== 0)
    return `${s.name}: the record does not carry the dive`;
  return undefined;
}

describe('dive points (V-05)', () => {
  it('the fixture has both kinds, and every origin kind the contract knows', () => {
    expect(fragments.length).toBeGreaterThanOrEqual(10);
    expect(seeds.length).toBeGreaterThanOrEqual(8);
    const kinds = new Set(seeds.map((s) => s.origin.kind));
    for (const k of DiveOriginSchema.shape.kind.options) expect(kinds, k).toContain(k);
  });

  it('the prefix is localised, and the cap is what the decision says', () => {
    expect(tellMeMore('en')).toBe('Tell me more about this:');
    expect(tellMeMore('da')).not.toBe(tellMeMore('en'));
    expect(tellMeMore('de')).not.toBe(tellMeMore('en'));
    expect(DIVE_MAX_CHARS).toBe(300);
  });

  it('handles fragments and seeds turn zero as labelled, on the share the registry demands', async () => {
    let agreed = 0;
    const misses: string[] = [];
    for (const s of fragments) {
      const why = fragmentDisagreement(s);
      if (why) misses.push(why);
      else agreed += 1;
    }
    for (const s of seeds) {
      const queries: string[] = [];
      const seen: ModelInput<'advise'>[] = [];
      const a = await seedTurnZero(s, stubFor(s, seen), queries);
      let why = seedDisagreement(s, a, queries);
      // Turn zero carries the fragment fenced as quoted data, never in the question.
      const input = seen[0];
      if (!why && input) {
        const quoted = (input.untrusted ?? []).find((u) => u.source.description.startsWith(QUOTED));
        if (!quoted || quoted.text !== stripFragment(s.fragment))
          why = `${s.name}: the fragment is not fenced`;
        else if (input.question.includes(stripFragment(s.fragment)))
          why = `${s.name}: the fragment is in the question`;
        else if (input.facts?.length !== caseFacts(CASES[s.case].record).length)
          why = `${s.name}: the case is not in turn zero`;
        else if (
          (input.passages ?? []).some((p) => p.ref.startsWith('TEST-DK')) &&
          CASES[s.case].jurisdiction === 'DE'
        )
          why = `${s.name}: Danish law offered to a German case`;
      }
      if (why) misses.push(why);
      else agreed += 1;
    }
    const threshold = thresholdOf('dive-points');
    recordEvalResult({
      set: 'dive-points',
      mode: 'pipeline',
      agreed,
      total: scenarios.length,
      threshold,
      misses,
    });
    expect(agreed / scenarios.length, misses.join('\n')).toBeGreaterThanOrEqual(threshold);
  });

  describe.skipIf(!process.env['MODEL_BASE_URL'])('the model, measured', () => {
    it('seeds turn zero and answers from it on the share the registry demands', async () => {
      const stack = advisorStack()!;
      let agreed = 0;
      const misses: string[] = [];
      for (const s of fragments) {
        const why = fragmentDisagreement(s);
        if (why) misses.push(why);
        else agreed += 1;
      }
      for (const s of seeds) {
        const queries: string[] = [];
        const a = await seedTurnZero(s, stack.client, queries);
        const why = seedDisagreement(s, a, queries);
        if (why) misses.push(why);
        else agreed += 1;
      }
      const threshold = thresholdOf('dive-points');
      recordEvalResult({
        set: 'dive-points',
        mode: 'model',
        agreed,
        total: scenarios.length,
        threshold,
        misses,
      });
      expect(agreed / scenarios.length, misses.join('\n')).toBeGreaterThanOrEqual(threshold);
    }, 600_000);
  });
});

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

describe.skipIf(!url)('a dive opens a conversation; further turns and dives append', () => {
  let t: TestDatabase;
  let tenantId = '';
  let caseId = '';
  const mette = { kind: 'person' as const, userId: 'u-mette', name: 'Mette' };
  const s = seeds.find((x) => x.case === 'dk-shop')!;
  const stub: Pick<ModelClient, 'call'> = {
    call: (async (request: { input: unknown }): Promise<ModelOutput<'advise'>> => {
      const input = request.input as ModelInput<'advise'>;
      const first = input.facts?.[0];
      return {
        answer: `Svar ${(input.history ?? []).length + 1}.`,
        caseSays: first ? [first] : [],
        lawSays: [],
        refuse: !first,
        ...(first ? {} : { missing: 'et fund' }),
      };
    }) as ModelClient['call'],
  };

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: NOW,
    });
    tenantId = opened.tenantId;
    caseId = opened.caseId;
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('turn zero is recorded with its dive and its thread; a follow-up and a further dive append; every dive is on the timeline', async () => {
    const stack = { client: stub, embedder: deterministicEmbedder(), model: 'stub' };
    // The case here holds no findings, so the stub refuses; the mechanics are what is measured.
    const zero = await askAdvisor(t, tenantId, {
      caseId,
      dive: { origin: s.origin, fragment: s.fragment, source: `${s.origin.kind} ${s.origin.ref}` },
      by: mette,
      stack: stack as never,
      now: NOW,
    });
    expect(zero.thread?.turn).toBe(0);
    expect(zero.dive?.fragment).toBe(stripFragment(s.fragment));
    expect(zero.question.startsWith(tellMeMore('da'))).toBe(true);
    const threadId = zero.thread!.id;

    const one = await askAdvisor(t, tenantId, {
      caseId,
      question: 'Og hvad så?',
      thread: threadId,
      by: mette,
      stack: stack as never,
      now: NOW,
    });
    expect(one.thread).toEqual({ id: threadId, turn: 1 });
    expect(one.dive).toBeUndefined();

    const two = await askAdvisor(t, tenantId, {
      caseId,
      dive: { origin: { kind: 'answer', ref: one.at }, fragment: one.answer, source: 'answer' },
      thread: threadId,
      by: mette,
      stack: stack as never,
      now: NOW,
    });
    expect(two.thread).toEqual({ id: threadId, turn: 2 });
    expect(two.dive?.origin.kind).toBe('answer');

    const thread = await threadOf(t, tenantId, caseId, threadId);
    expect(thread.map((a) => a.thread?.turn)).toEqual([0, 1, 2]);
    expect((await adviceOf(t, tenantId, caseId)).length).toBe(3);
    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    const dives = events.filter((e) => e.type === 'dive_requested');
    expect(dives).toHaveLength(2);
    expect(dives[0]!.payload).toMatchObject({ threadId, turn: 0, origin: s.origin });
    expect(dives[1]!.payload).toMatchObject({ threadId, turn: 2, origin: { kind: 'answer' } });
    // A new conversation starts without a thread.
    const fresh = await askAdvisor(t, tenantId, {
      caseId,
      question: 'Noget nyt?',
      by: mette,
      stack: stack as never,
      now: NOW,
    });
    expect(fresh.thread?.id).not.toBe(threadId);
    expect(fresh.thread?.turn).toBe(0);
  });
});
