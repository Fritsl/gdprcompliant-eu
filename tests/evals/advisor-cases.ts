import { words, type AdviseInput, type CaseFactsInput } from '@gc/agent';
import type { Jurisdiction, Locale } from '@gc/contracts';
import { corpusChunks, speaksIn } from '@gc/corpus';

// The two cases the advisor evals share (V-02, V-04, V-05), held in memory: the same
// facts and the same labels the database-backed eval seeds, with no database needed to
// measure a refusal or a dive.

const HASH = 'a'.repeat(64);
export const EV = { evidenceId: 'document:0123456789abcdef', hash: HASH };

export type CaseKey = 'dk-shop' | 'de-practice';

export const CASES: Record<
  CaseKey,
  { locale: Locale; jurisdiction: Jurisdiction; record: CaseFactsInput }
> = {
  'dk-shop': {
    locale: 'da',
    jurisdiction: 'DK',
    record: {
      findings: [
        {
          id: 'f1',
          typeId: 'DPA-01',
          status: 'open',
          summary: 'Vi bruger Sendmore til at sende vores nyhedsbreve.',
          evidence: [EV],
        },
      ],
      rows: [
        {
          activityId: 'a1',
          key: 'newsletter',
          name: 'Nyhedsbrev',
          attributes: {},
          purposes: ['marketing'],
          dataCategories: ['email'],
          legalBases: ['consent'],
          recipients: [{ nodeId: 'v1', name: 'Sendmore' }],
          transfers: [],
          risks: [],
          controls: [],
          origin: 'derived',
          confidence: 0.6,
          evidence: [EV],
          draft: true,
          contradictions: 0,
        },
      ],
      answers: [
        {
          id: 'answer:dk:q-dpo',
          questionId: 'q-dpo',
          answer: 'no',
          asks: 'Har I udpeget en databeskyttelsesrådgiver?',
        },
        {
          id: 'answer:dk:q-headcount',
          questionId: 'q-headcount',
          answer: '1-9',
          asks: 'Hvor mange arbejder i virksomheden?',
        },
      ],
      vendors: [{ nodeId: 'v1', name: 'Sendmore', role: 'processor', evidence: [EV] }],
    },
  },
  'de-practice': {
    locale: 'de',
    jurisdiction: 'DE',
    record: {
      findings: [
        {
          id: 'f2',
          typeId: 'DPA-02',
          status: 'open',
          summary:
            'Unsere Patientenakten liegen bei Praxis Cloud; ein Vertrag zur Auftragsverarbeitung besteht.',
          evidence: [EV],
        },
      ],
      rows: [],
      answers: [
        {
          id: 'answer:de:q-health-data',
          questionId: 'q-health-data',
          answer: 'yes',
          asks: 'Verarbeiten Sie Gesundheitsdaten von Kundinnen, Kunden oder Patienten?',
        },
        {
          id: 'answer:de:q-headcount',
          questionId: 'q-headcount',
          answer: '10-49',
          asks: 'Wie viele Menschen arbeiten im Unternehmen?',
        },
      ],
      vendors: [
        {
          nodeId: 'v2',
          name: 'Praxis Cloud GmbH',
          country: 'DE',
          role: 'processor',
          evidence: [EV],
        },
      ],
    },
  },
};

// Retrieval by word overlap over the content files: enough to offer the model real
// passages of the right jurisdiction without a store.
export const lexical: AdviseInput['retrieve'] = async (question, jurisdiction, k) => {
  const wanted = new Set(words(question));
  const scored = corpusChunks()
    .filter((c) => speaksIn(c.jurisdiction, jurisdiction))
    .map((chunk) => {
      let score = 0;
      for (const w of new Set(words(chunk.text))) if (wanted.has(w)) score += 1;
      return { chunk, distance: 1 - score / Math.sqrt(chunk.text.length + 1) };
    })
    .sort((a, b) => a.distance - b.distance);
  return scored.slice(0, k);
};

// A fact selector as the fixtures write it: "finding:DPA-01", "vendor:Sendmore",
// "answer:q-dpo", "register:" (any register row).
const PREFIX: Record<string, string> = {
  finding: 'Finding ',
  vendor: 'Supplier: ',
  answer: 'Answer ',
  register: 'Register: ',
};
export const selects = (selector: string, label: string): boolean => {
  const [kind, needle] = selector.split(':', 2) as [string, string];
  return label.startsWith(PREFIX[kind] ?? ' ') && label.includes(needle ?? '');
};
