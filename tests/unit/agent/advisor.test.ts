import { describe, expect, it } from 'vitest';
import {
  OUTPUT_GUARDS,
  advise,
  caseFacts,
  settlingQuestion,
  verbatimSpan,
  words,
  type AdviseInput,
  type CatalogueQuestion,
} from '@gc/agent';
import { AdviceSchema, type CorpusChunk, type ModelInput, type ModelOutput } from '@gc/contracts';

// The advisor's deterministic parts (V-02): the facts are labelled and pointed, the
// settling question is found by its own words or not at all, a quote is taken
// verbatim, and a model that invents a fact or a passage is stripped of it.

const HASH = 'a'.repeat(64);
const EV = { evidenceId: 'document:0123456789abcdef', hash: HASH };

const record = {
  findings: [
    { id: 'f1', typeId: 'DPA-01', status: 'open', summary: 'Vi bruger Sendmore.', evidence: [EV] },
    { id: 'f2', typeId: 'SEC-03', status: 'open', evidence: [] },
  ],
  rows: [
    {
      activityId: 'a1',
      key: 'newsletter',
      name: 'Nyhedsbrev',
      attributes: { dataSubjects: ['customers'], retention: '2 years' },
      purposes: ['marketing'],
      dataCategories: ['email'],
      legalBases: ['consent'],
      recipients: [{ nodeId: 'v1', name: 'Sendmore' }],
      transfers: [],
      risks: [],
      controls: [],
      origin: 'derived' as const,
      confidence: 0.6,
      evidence: [EV],
      draft: true,
      contradictions: 0,
    },
  ],
  answers: [
    {
      id: 'answer:c:q-dpo',
      questionId: 'q-dpo',
      answer: 'no',
      asks: 'Har I udpeget en databeskyttelsesrådgiver?',
    },
  ],
  vendors: [{ nodeId: 'v1', name: 'Sendmore', country: 'IE', role: 'processor', evidence: [EV] }],
};

const catalogue: CatalogueQuestion[] = [
  {
    id: 'q-cctv',
    asks: 'Optager kameraer kunder eller medarbejdere?',
    facts: ['company.usesCctv'],
  },
  { id: 'q-dpo', asks: 'Har I udpeget en databeskyttelsesrådgiver?', facts: ['company.hasDpo'] },
  {
    id: 'q-health-data',
    asks: 'Håndterer I helbredsoplysninger om kunder eller patienter?',
    facts: ['company.processesHealthData'],
  },
];

const chunk: CorpusChunk = {
  id: 'GDPR:28:3',
  corpusVersion: '2026-09-04',
  instrument: 'GDPR',
  jurisdiction: 'EU',
  kind: 'article',
  article: '28',
  paragraph: '3',
  text: 'Processing by a processor shall be governed by a contract   or other legal act.',
  hash: HASH,
  source: { url: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj', title: 'GDPR' },
};

describe('caseFacts', () => {
  it('labels every fact and points it at the evidence or the answer that placed it', () => {
    const facts = caseFacts(record);
    expect(facts.map((f) => f.kind)).toEqual(['finding', 'register', 'answer', 'vendor']);
    expect(facts[0]).toMatchObject({
      label: 'Finding DPA-01 (open)',
      value: 'Vi bruger Sendmore.',
      pointer: { kind: 'evidence', ...EV },
    });
    expect(facts[1]!.label).toBe('Register: Nyhedsbrev (draft)');
    expect(facts[1]!.value).toContain('recipients Sendmore');
    expect(facts[1]!.value).toContain('kept 2 years');
    expect(facts[2]).toMatchObject({
      label: 'Answer q-dpo: Har I udpeget en databeskyttelsesrådgiver?',
      value: 'no',
      pointer: { kind: 'answer', answerId: 'answer:c:q-dpo', questionId: 'q-dpo' },
    });
    expect(facts[3]!.value).toBe('processor in IE');
  });
});

describe('settlingQuestion', () => {
  it('finds the question by the words of what was asked and what is missing', () => {
    expect(
      settlingQuestion('Må vi sætte kameraer op?', 'om kameraer optager kunder', catalogue)?.id,
    ).toBe('q-cctv');
    expect(
      settlingQuestion('Do we need a DPO?', 'whether the company has a dpo', catalogue)?.id,
    ).toBe('q-dpo');
  });
  it('names nothing when nothing overlaps enough', () => {
    expect(settlingQuestion('Må vi hoste i USA?', 'hvilket land', catalogue)).toBeUndefined();
    expect(settlingQuestion('anything', undefined, [])).toBeUndefined();
  });
  it('splits words without stopwords and keeps accented letters', () => {
    expect(words('Do we need a DPO for the Café?')).toEqual(['dpo', 'café']);
  });
});

describe('verbatimSpan', () => {
  it('finds the passage span a whitespace-folded quote came from', () => {
    expect(verbatimSpan(chunk.text, 'a contract or other')).toBe('a contract   or other');
    expect(verbatimSpan(chunk.text, 'a treaty or other')).toBeUndefined();
  });
});

describe('the advise guard', () => {
  const input: ModelInput<'advise'> = {
    question: 'q',
    locale: 'en',
    jurisdiction: 'DK',
    facts: [{ label: 'Finding DPA-01 (open)', value: 'Vi bruger Sendmore.' }],
    passages: [{ key: 'GDPR:28:3', ref: 'GDPR Art. 28(3)', text: chunk.text }],
  };
  it('lets through an answer that repeats only what was offered', () => {
    const out: ModelOutput<'advise'> = {
      answer: 'a',
      caseSays: [{ label: 'Finding DPA-01 (open)', value: 'Vi bruger Sendmore.' }],
      lawSays: [{ key: 'GDPR:28:3', quote: 'governed by a contract or other' }],
      refuse: false,
    };
    expect(OUTPUT_GUARDS.advise!(input, out)).toEqual([]);
  });
  it('names an invented fact, an unknown key and a quote that is not in the passage', () => {
    const out: ModelOutput<'advise'> = {
      answer: 'a',
      caseSays: [{ label: 'Finding CK-01 (open)', value: 'cookies before consent' }],
      lawSays: [
        { key: 'GDPR:99', quote: 'x' },
        { key: 'GDPR:28:3', quote: 'governed by a treaty' },
      ],
      refuse: false,
    };
    const issues = OUTPUT_GUARDS.advise!(input, out);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toContain('not a fact the case supplied');
    expect(issues[1]).toContain('not among the passages offered');
    expect(issues[2]).toContain('not in GDPR:28:3');
  });
});

describe('advise', () => {
  const base: Omit<AdviseInput, 'retrieve'> = {
    question: 'Skal vi have en aftale med Sendmore?',
    locale: 'da',
    jurisdiction: 'DK',
    facts: caseFacts(record),
    catalogue,
    now: () => new Date('2026-09-04T10:00:00Z'),
  };
  const retrieve: AdviseInput['retrieve'] = async () => [{ chunk, distance: 0.1 }];
  const client = (out: ModelOutput<'advise'>) => ({ call: async () => out });

  it('keeps the three parts apart and maps the law back to a resolving citation', async () => {
    const a = await advise(
      client({
        answer: 'Ja.',
        caseSays: [{ label: 'Finding DPA-01 (open)', value: 'Vi bruger Sendmore.' }],
        lawSays: [{ key: 'GDPR:28:3', quote: 'governed by a contract or other legal act' }],
        refuse: false,
      }),
      { ...base, retrieve },
    );
    expect(a.refused).toBeUndefined();
    expect(a.caseSays.map((f) => f.label)).toEqual(['Finding DPA-01 (open)']);
    expect(a.lawSays[0]).toMatchObject({
      key: 'GDPR:28:3',
      citation: { kind: 'provision', instrument: 'GDPR', article: '28', paragraph: '3' },
      quote: 'governed by a contract   or other legal act',
      corpusVersion: '2026-09-04',
    });
    expect(AdviceSchema.safeParse(a).success).toBe(true);
  });

  it('turns an answer that rests on invented facts into a refusal', async () => {
    const a = await advise(
      client({
        answer: 'Ja.',
        caseSays: [{ label: 'Finding CK-01 (open)', value: 'invented' }],
        lawSays: [{ key: 'GDPR:99', quote: 'invented' }],
        refuse: false,
      }),
      { ...base, retrieve },
    );
    expect(a.refused).toBeDefined();
    expect(a.caseSays).toEqual([]);
    expect(a.lawSays).toEqual([]);
  });

  it('a refusal names the settling question from the model’s account of what is missing', async () => {
    const a = await advise(
      client({
        answer: 'Sagen siger ikke noget om kameraer.',
        caseSays: [],
        lawSays: [],
        refuse: true,
        missing: 'om kameraer optager kunder eller medarbejdere',
      }),
      { ...base, question: 'Må vi sætte kameraer op i butikken?', retrieve },
    );
    expect(a.refused).toMatchObject({
      reason: 'om kameraer optager kunder eller medarbejdere',
      question: { id: 'q-cctv' },
    });
  });

  it('drops law from another jurisdiction even when the retrieval offers it', async () => {
    const dk: CorpusChunk = {
      ...chunk,
      id: 'TEST-DK:3',
      instrument: 'TEST-DK',
      jurisdiction: 'DK',
      article: '3',
    };
    const a = await advise(
      client({
        answer: 'x',
        caseSays: [{ label: 'Finding DPA-01 (open)', value: 'Vi bruger Sendmore.' }],
        lawSays: [{ key: 'TEST-DK:3', quote: 'governed by a contract' }],
        refuse: false,
      }),
      { ...base, jurisdiction: 'DE', retrieve: async () => [{ chunk: dk, distance: 0 }] },
    );
    expect(a.lawSays).toEqual([]);
  });
});
