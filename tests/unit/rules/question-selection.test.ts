import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Company, RegisterRow } from '@gc/contracts';
import {
  answerFacts,
  checkQuestions,
  evaluate,
  explainSelection,
  factsFrom,
  factsSetBy,
  inferSector,
  loadQuestions,
  loadRuleSets,
  loadSectors,
  rulesReading,
  selectQuestions,
  type Facts,
} from '@gc/rules';

// Sector inference and question selection (D-09). Selection is the rules engine run
// backwards: a question is asked only when an answer would settle a duty the engine
// cannot decide, never for a fact the sheet already holds, never twice, and every
// selection says in words which duties turn on it. The sector comes from the register's
// code or the site's signals, and only orders what is asked first.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const sets = loadRuleSets();
const catalogue = loadQuestions();
const sectors = loadSectors();

const company: Company = { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' };
const row = (over: Partial<RegisterRow>): RegisterRow => ({
  activityId: 'node:activity:1',
  key: 'activity:orders',
  name: 'orders',
  attributes: {},
  purposes: ['orders'],
  dataCategories: ['contact'],
  legalBases: ['contract'],
  recipients: [],
  transfers: [],
  risks: [],
  controls: [],
  origin: 'derived',
  confidence: 0.6,
  evidence: [{ evidenceId: 'form:1', hash: 'a'.repeat(64) }],
  draft: true,
  contradictions: 0,
  ...over,
});
const undetermined = (facts: Facts) =>
  evaluate(sets, { caseId: 'DK-26-TEST', jurisdiction: 'DK', facts })
    .filter((d) => d.status === 'undetermined')
    .map((d) => d.ruleId);

describe('the question catalogue', () => {
  it('is content the check accepts: every question sets held facts and declares what it settles', () => {
    expect(checkQuestions(catalogue, sets, sectors)).toEqual([]);
    expect(catalogue.questions.length).toBeGreaterThanOrEqual(6);
  });

  it('each question declares exactly the rules that read a fact its answers set', () => {
    for (const q of catalogue.questions) {
      expect(q.resolves.length, q.id).toBeGreaterThan(0);
      expect([...q.resolves].sort(), q.id).toEqual(rulesReading(q, sets));
      expect(factsSetBy(q).length, q.id).toBeGreaterThan(0);
    }
  });

  it('refuses a question nothing turns on, or one whose declaration the rules do not bear out', () => {
    const idle = {
      ...catalogue,
      questions: [
        {
          ...catalogue.questions[0]!,
          id: 'q-idle',
          options: [
            { id: 'a', label: { en: 'A' }, sets: { 'company.sellsService': true } },
            { id: 'b', label: { en: 'B' }, sets: { 'company.sellsService': false } },
          ],
          resolves: ['record-of-processing'],
        },
      ],
    };
    const problems = checkQuestions(idle, sets, sectors);
    expect(problems.some((p) => p.includes('settles no rule'))).toBe(true);
    expect(problems.some((p) => p.includes('declares it resolves'))).toBe(true);
    const unheld = {
      ...catalogue,
      questions: [
        {
          ...catalogue.questions[0]!,
          options: [
            { id: 'a', label: { en: 'A' }, sets: { 'company.mood': 'fine' } },
            catalogue.questions[0]!.options[0]!,
          ],
        },
      ],
    };
    expect(checkQuestions(unheld, sets, sectors).some((p) => p.includes('never holds'))).toBe(true);
  });

  it('speaks every supported locale and asks, in each, a question', () => {
    for (const q of catalogue.questions) {
      for (const locale of ['en', 'da', 'de'] as const) {
        expect(q.asks[locale], `${q.id} ${locale}`).toMatch(/\?$/);
        expect(q.why[locale], `${q.id} ${locale}`).toBeTruthy();
        for (const o of q.options)
          expect(o.label[locale], `${q.id} ${o.id} ${locale}`).toBeTruthy();
      }
      // A statement and a question never share a sentence: what is known is not in `asks`.
      expect(q.asks['en'].split('?')).toHaveLength(2);
    }
  });
});

describe('selection is driven by the rules engine', () => {
  it('asks only what would settle a duty the engine cannot decide', () => {
    const facts = factsFrom({ company, rows: [], sectors }).facts;
    const before = undetermined(facts);
    const { asked } = selectQuestions(sets, catalogue, { jurisdiction: 'DK', facts });
    expect(asked.length).toBeGreaterThan(0);
    for (const s of asked) {
      expect(s.resolves.length).toBeGreaterThan(0);
      for (const r of s.resolves) expect(before).toContain(r.ruleId);
      // Some answer really settles each duty named.
      for (const r of s.resolves) {
        const settledBySome = s.question.options.some(
          (o) => !undetermined({ ...facts, ...o.sets }).includes(r.ruleId),
        );
        expect(settledBySome, `${s.question.id} settles ${r.ruleId}`).toBe(true);
      }
    }
  });

  it('is deterministic and reads no model: the same sheet gives the same questions in the same order', () => {
    const facts = factsFrom({ company, rows: [row({})], sectors }).facts;
    const a = selectQuestions(sets, catalogue, { jurisdiction: 'DK', facts, sector: 'retail' });
    const b = selectQuestions(sets, catalogue, { jurisdiction: 'DK', facts, sector: 'retail' });
    expect(a.asked.map((s) => s.question.id)).toEqual(b.asked.map((s) => s.question.id));
    const dir = join(ROOT, 'packages/rules/src');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/@gc\/agent|@gc\/model|dispatcher|createModel/i);
    }
  });

  it('ranks the question that settles the most duties first, and honours the limit', () => {
    const facts = factsFrom({ company, rows: [], sectors }).facts;
    const { asked, skipped } = selectQuestions(sets, catalogue, {
      jurisdiction: 'DK',
      facts,
      limit: 2,
    });
    expect(asked).toHaveLength(2);
    expect(asked[0]!.rank).toBe(1);
    expect(asked[0]!.resolves.length).toBeGreaterThanOrEqual(asked[1]!.resolves.length);
    expect(skipped.some((s) => s.reason === 'beyond the first 2')).toBe(true);
  });
});

describe('never asks what evidence already answers', () => {
  it('does not ask about cookies once the scan has looked', () => {
    const unscanned = factsFrom({ company, rows: [], sectors }).facts;
    const scanned = factsFrom({
      company,
      rows: [],
      cookies: { total: 3, nonNecessary: 1 },
      sectors,
    }).facts;
    const ids = (f: Facts) =>
      selectQuestions(sets, catalogue, { jurisdiction: 'DK', facts: f }).asked.map(
        (s) => s.question.id,
      );
    expect(ids(unscanned)).toContain('q-cookies');
    expect(ids(scanned)).not.toContain('q-cookies');
    const { skipped } = selectQuestions(sets, catalogue, { jurisdiction: 'DK', facts: scanned });
    expect(skipped).toContainEqual({
      questionId: 'q-cookies',
      reason: 'already known from evidence held',
    });
  });

  it('does not ask for the headcount the register gave', () => {
    const banded = factsFrom({
      company: { ...company, headcountBand: '10–19' },
      rows: [],
      sectors,
    });
    const { asked, skipped } = selectQuestions(sets, catalogue, {
      jurisdiction: 'DK',
      facts: banded.facts,
    });
    expect(asked.map((s) => s.question.id)).not.toContain('q-headcount');
    expect(skipped.find((s) => s.questionId === 'q-headcount')?.reason).toBe(
      'already known from evidence held',
    );
  });

  it('does not ask about health data when the register already holds it', () => {
    const facts = factsFrom({
      company,
      rows: [row({ name: 'sensitive_enquiries', dataCategories: ['contact', 'health'] })],
      sectors,
    }).facts;
    expect(facts['company.processesHealthData']).toBe(true);
    expect(facts['company.sector']).toBe('healthcare');
    const { asked } = selectQuestions(sets, catalogue, {
      jurisdiction: 'DK',
      facts,
      sector: facts['company.sector'] as string,
    });
    expect(asked.map((s) => s.question.id)).not.toContain('q-health-data');
  });

  it('asks about customer files only where the register shows mail and documents', () => {
    const without = factsFrom({ company, rows: [row({})], sectors }).facts;
    const withMail = factsFrom({
      company,
      rows: [row({}), row({ key: 'activity:email', name: 'email_and_documents' })],
      sectors,
    }).facts;
    const ids = (f: Facts) =>
      selectQuestions(sets, catalogue, { jurisdiction: 'DK', facts: f, limit: 10 }).asked.map(
        (s) => s.question.id,
      );
    expect(ids(without)).not.toContain('q-customer-files');
    expect(ids(withMail)).toContain('q-customer-files');
  });

  it('never asks twice: an answer fills the sheet and the question drops out', () => {
    const base = factsFrom({ company, rows: [], sectors }).facts;
    const first = selectQuestions(sets, catalogue, { jurisdiction: 'DK', facts: base, limit: 10 });
    const ai = first.asked.find((s) => s.question.id === 'q-ai-assistants');
    expect(ai).toBeDefined();
    expect(undetermined(base)).toContain('ai-assistant-processor');
    const answers = answerFacts(catalogue, [{ questionId: 'q-ai-assistants', optionId: 'yes' }]);
    expect(answers).toEqual({ 'company.staffUseAiWithCustomerData': true });
    const after = factsFrom({ company, rows: [], answers, sectors }).facts;
    expect(undetermined(after)).not.toContain('ai-assistant-processor');
    const second = selectQuestions(sets, catalogue, {
      jurisdiction: 'DK',
      facts: after,
      answered: ['q-ai-assistants'],
      limit: 10,
    });
    expect(second.asked.map((s) => s.question.id)).not.toContain('q-ai-assistants');
    expect(second.asked.length).toBe(first.asked.length - 1);
    // "Not sure" sets nothing, and the question is still not asked again.
    const unsure = answerFacts(catalogue, [{ questionId: 'q-ai-assistants', optionId: 'unsure' }]);
    expect(unsure).toEqual({});
    const third = selectQuestions(sets, catalogue, {
      jurisdiction: 'DK',
      facts: base,
      answered: ['q-ai-assistants'],
      limit: 10,
    });
    expect(third.skipped).toContainEqual({
      questionId: 'q-ai-assistants',
      reason: 'already answered',
    });
  });

  it('an answer never overwrites what was observed', () => {
    const facts = factsFrom({
      company,
      rows: [],
      cookies: { total: 0, nonNecessary: 0 },
      answers: { 'site.setsNonNecessaryCookies': true },
      sectors,
    }).facts;
    expect(facts['site.setsNonNecessaryCookies']).toBe(false);
  });
});

describe('the sector', () => {
  it('comes from the register code first, longest prefix winning, and says so', () => {
    const online = inferSector({ sectorCode: '47.91.10' }, sectors);
    expect(online).toMatchObject({ sector: 'online-retail', confidence: 'registry' });
    expect(online.because[0]).toContain('47.91');
    expect(inferSector({ sectorCode: '471110' }, sectors).sector).toBe('retail');
    expect(inferSector({ sectorCode: '86.21.00' }, sectors).sector).toBe('healthcare');
  });

  it('falls back to the site, and stays unknown on a tie or on nothing', () => {
    const shop = inferSector({ activities: ['orders', 'newsletter'] }, sectors);
    expect(shop).toMatchObject({ sector: 'online-retail', confidence: 'signals' });
    expect(shop.because.join(' ')).toContain('orders');
    const nothing = inferSector({}, sectors);
    expect(nothing).toMatchObject({ sector: 'unknown', confidence: 'none' });
    expect(nothing.because.join(' ')).toContain('nothing read');
    const odd = inferSector({ sectorCode: '01.11' }, sectors);
    expect(odd.sector).toBe('unknown');
    expect(odd.because.join(' ')).toContain('matches no sector');
    const tie = inferSector({ activities: ['orders', 'accounts'] }, sectors);
    expect(tie.sector).toBe('unknown');
    expect(tie.because.join(' ')).toContain('equally');
  });

  it('is on the fact sheet with its reasons, from the company or the register', () => {
    const sheet = factsFrom({ company: { ...company, sectorCode: '47.91.10' }, rows: [], sectors });
    expect(sheet.facts['company.sectorCode']).toBe('47.91.10');
    expect(sheet.facts['company.sector']).toBe('online-retail');
    expect(sheet.sector.confidence).toBe('registry');
    const bare = factsFrom({ company, rows: [], sectors });
    expect(bare.facts['company.sector']).toBeUndefined();
    expect(bare.sector.sector).toBe('unknown');
  });

  it('puts the sector’s own questions first and leaves out those that belong elsewhere', () => {
    const facts = factsFrom({
      company: { ...company, sectorCode: '86.21' },
      rows: [],
      sectors,
    }).facts;
    const clinic = selectQuestions(sets, catalogue, {
      jurisdiction: 'DK',
      facts,
      sector: 'healthcare',
      limit: 10,
    });
    const ids = clinic.asked.map((s) => s.question.id);
    expect(ids[0]).toBe('q-cctv');
    expect(ids.slice(0, 2)).toContain('q-health-data');
    expect(ids).not.toContain('q-children');
    expect(clinic.skipped).toContainEqual({
      questionId: 'q-children',
      reason: 'not asked in healthcare',
    });
    // With no sector known, nothing is left out on sector grounds.
    const unknown = selectQuestions(sets, catalogue, { jurisdiction: 'DK', facts, limit: 10 });
    expect(unknown.skipped.some((s) => s.reason.startsWith('not asked in'))).toBe(false);
  });
});

describe('the case can show why it asked', () => {
  it('every selection names the duties that turn on it, in the reader’s language', () => {
    const facts = factsFrom({
      company: { ...company, sectorCode: '86.21' },
      rows: [],
      sectors,
    }).facts;
    const { asked } = selectQuestions(sets, catalogue, {
      jurisdiction: 'DK',
      facts,
      sector: 'healthcare',
      limit: 10,
    });
    for (const s of asked) {
      expect(s.fills.length).toBeGreaterThan(0);
      const en = explainSelection(s, catalogue, 'en', sectors, 'healthcare');
      expect(en).toMatch(/^Asked because/);
      for (const r of s.resolves) expect(en).toContain(r.title['en']);
      const da = explainSelection(s, catalogue, 'da', sectors, 'healthcare');
      expect(da).toMatch(/^Spurgt/);
      for (const r of s.resolves) expect(da).toContain(r.title['da'] ?? r.title['en']);
    }
    const health = asked.find((s) => s.question.id === 'q-health-data')!;
    expect(explainSelection(health, catalogue, 'en', sectors, 'healthcare')).toContain(
      'works in health and care',
    );
    expect(explainSelection(health, catalogue, 'de', sectors, 'healthcare')).toContain(
      'Gesundheit und Pflege',
    );
    const cookies = selectQuestions(sets, catalogue, {
      jurisdiction: 'DK',
      facts,
      limit: 10,
    }).asked.find((s) => s.question.id === 'q-cookies')!;
    expect(explainSelection(cookies, catalogue, 'en')).not.toContain('works in');
  });
});
