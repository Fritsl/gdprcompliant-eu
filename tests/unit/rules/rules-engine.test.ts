import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DutySchema, type Company, type RegisterRow } from '@gc/contracts';
import { documentChunks, loadCorpusDocuments, resolveInChunks } from '@gc/corpus';
import {
  FACT_NAMES,
  RuleSchema,
  RuleSetSchema,
  citationsOf,
  evaluate,
  evaluateCondition,
  factsFrom,
  factsUsed,
  headcountRange,
  loadRuleSets,
  runExamples,
  statusOf,
  type Facts,
} from '@gc/rules';

// The obligations engine (A-02): rules are data a person can read, with a citation and
// a worked example each; evaluation is three-valued, total and deterministic; the fact
// sheet comes from the register and the company; and every rule set on disk resolves
// its citations in the corpus and passes its own examples.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const sets = loadRuleSets();
const chunks = loadCorpusDocuments().flatMap(documentChunks);

const rule = (over: Partial<Parameters<typeof RuleSchema.parse>[0]> = {}) =>
  RuleSchema.parse({
    id: 'test-rule',
    title: { en: 'A test rule' },
    summary: { en: 'What the test rule asks.' },
    when: { fact: 'register.rows', op: 'gte', value: 1 },
    citations: [{ instrument: 'GDPR', ref: 'Art. 30(1)' }],
    examples: [{ name: 'one row', facts: { 'register.rows': 1 }, expect: 'applies' }],
    ...over,
  });

describe('the rule language', () => {
  it('reads as data: a condition over named facts, a citation, an example', () => {
    const r = rule();
    expect(r.when).toEqual({ fact: 'register.rows', op: 'gte', value: 1 });
    // Reviewable without code: the file is plain JSON with words for everything.
    const eu = JSON.parse(
      readFileSync(join(ROOT, 'packages', 'rules', 'content', 'EU.json'), 'utf8'),
    );
    expect(
      eu.rules.every(
        (x: { title: { en: string }; summary: { en: string } }) => x.title.en && x.summary.en,
      ),
    ).toBe(true);
    expect(JSON.stringify(eu)).not.toMatch(/=>|function|\$\{/);
  });

  it('refuses a rule without a citation, without an example, or with an unknown operator', () => {
    expect(() => rule({ citations: [] })).toThrow(/cites the provision/);
    expect(() => rule({ examples: [] })).toThrow(/at least one example/);
    expect(() =>
      rule({ when: { fact: 'register.rows', op: 'between', value: 1 } as never }),
    ).toThrow();
    expect(() => rule({ when: { fact: 'register.rows', op: 'gte' } as never })).toThrow(
      /compares against a value/,
    );
    expect(() =>
      RuleSetSchema.parse({ version: '2026-09-04', jurisdiction: 'EU', rules: [rule(), rule()] }),
    ).toThrow(/duplicate rule id/);
  });
});

describe('evaluation', () => {
  const facts: Facts = {
    'register.rows': 2,
    'register.usesConsent': true,
    'register.bases': ['consent', 'contract'],
    'company.country': 'DK',
  };

  it('is three-valued: a fact the sheet lacks is unknown, not false', () => {
    expect(evaluateCondition({ fact: 'register.rows', op: 'gte', value: 1 }, facts)).toBe('true');
    expect(evaluateCondition({ fact: 'register.rows', op: 'gte', value: 3 }, facts)).toBe('false');
    expect(evaluateCondition({ fact: 'site.setsCookies', op: 'eq', value: true }, facts)).toBe(
      'unknown',
    );
    expect(evaluateCondition({ fact: 'site.setsCookies', op: 'exists' }, facts)).toBe('false');
    expect(
      evaluateCondition({ fact: 'register.bases', op: 'contains', value: 'consent' }, facts),
    ).toBe('true');
    expect(
      evaluateCondition({ fact: 'company.country', op: 'in', value: ['DK', 'DE'] }, facts),
    ).toBe('true');
    expect(
      evaluateCondition({ not: { fact: 'site.setsCookies', op: 'eq', value: true } }, facts),
    ).toBe('unknown');
    expect(
      evaluateCondition(
        {
          all: [
            { fact: 'register.rows', op: 'gte', value: 1 },
            { fact: 'site.setsCookies', op: 'eq', value: true },
          ],
        },
        facts,
      ),
    ).toBe('unknown');
    expect(
      evaluateCondition(
        {
          all: [
            { fact: 'register.rows', op: 'gte', value: 9 },
            { fact: 'site.setsCookies', op: 'eq', value: true },
          ],
        },
        facts,
      ),
    ).toBe('false');
    expect(
      evaluateCondition(
        {
          any: [
            { fact: 'register.rows', op: 'gte', value: 1 },
            { fact: 'site.setsCookies', op: 'eq', value: true },
          ],
        },
        facts,
      ),
    ).toBe('true');
  });

  it('maps unknown to undetermined, and an unless that might hold keeps the duty undetermined', () => {
    expect(statusOf(rule(), facts)).toBe('applies');
    expect(statusOf(rule(), { 'register.rows': 0 })).toBe('not_applicable');
    expect(statusOf(rule(), {})).toBe('undetermined');
    const withUnless = rule({ unless: { fact: 'company.headcountMax', op: 'lt', value: 10 } });
    expect(statusOf(withUnless, { 'register.rows': 1, 'company.headcountMax': 5 })).toBe(
      'not_applicable',
    );
    expect(statusOf(withUnless, { 'register.rows': 1, 'company.headcountMax': 50 })).toBe(
      'applies',
    );
    expect(statusOf(withUnless, { 'register.rows': 1 })).toBe('undetermined');
  });

  it('is total and deterministic: every rule gives a duty on any sheet, in the same order, and nothing throws', () => {
    for (const sheet of [{}, facts, { 'register.rows': 'not a number' as never }]) {
      const a = evaluate(sets, { caseId: 'DK-26-TEST', jurisdiction: 'DK', facts: sheet });
      const b = evaluate([...sets].reverse(), {
        caseId: 'DK-26-TEST',
        jurisdiction: 'DK',
        facts: sheet,
      });
      expect(a.length).toBe(
        sets.filter((s) => s.jurisdiction !== 'DE').reduce((n, s) => n + s.rules.length, 0),
      );
      expect(a).toEqual(b);
      for (const d of a) expect(DutySchema.safeParse(d).success, d.ruleId).toBe(true);
    }
    const de = evaluate(sets, { caseId: 'DE-26-TEST', jurisdiction: 'DE', facts });
    expect(de.some((d) => d.ruleId === 'de-authority-named')).toBe(true);
    expect(de.some((d) => d.ruleId === 'dk-authority-named')).toBe(false);
    // A jurisdiction's own rules come after the Union's, by id within each set.
    const ids = de.map((d) => d.ruleId);
    expect(ids.indexOf('de-authority-named')).toBe(ids.length - 1);
    expect(ids.slice(0, -1)).toEqual([...ids.slice(0, -1)].sort());
  });
});

describe('the fact sheet', () => {
  const company: Company = {
    domain: 'eksempelbutik.dk',
    country: 'DK',
    locale: 'da',
    headcountBand: '10–49',
    sellsService: true,
  };
  const row = (over: Partial<RegisterRow>): RegisterRow => ({
    activityId: 'node:activity:1',
    key: 'activity:newsletter',
    name: 'newsletter',
    attributes: {},
    purposes: ['newsletter'],
    dataCategories: ['contact'],
    legalBases: ['consent'],
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

  it('reads headcount bands as written', () => {
    expect(headcountRange('10–49')).toEqual({ min: 10, max: 49 });
    expect(headcountRange('250+')).toEqual({ min: 250 });
    expect(headcountRange('1-9')).toEqual({ min: 1, max: 9 });
    expect(headcountRange('many')).toBeUndefined();
  });

  it('derives every fact from the register and the company, and leaves out what it cannot', () => {
    const sheet = factsFrom({
      company,
      rows: [
        row({}),
        row({
          key: 'activity:orders',
          name: 'orders',
          legalBases: ['contract'],
          dataCategories: ['contact', 'financial'],
          recipients: [{ nodeId: 'n', name: 'Google Ireland Limited', country: 'IE' }],
          transfers: [{ nodeId: 't', vendor: 'Google Ireland Limited', attributes: {} }],
          draft: false,
          evidence: [{ evidenceId: 'form:2', hash: 'b'.repeat(64) }],
        }),
        row({
          key: 'activity:sensitive',
          name: 'sensitive_enquiries',
          dataCategories: ['health'],
          legalBases: ['explicit_consent'],
        }),
      ],
    });
    expect(sheet.facts).toMatchObject({
      'company.country': 'DK',
      'company.inEea': true,
      'company.sellsService': true,
      'company.headcountMin': 10,
      'company.headcountMax': 49,
      'register.rows': 3,
      'register.confirmedRows': 1,
      'register.recipients': 1,
      'register.recipientsOutsideEea': false,
      'register.transfers': 1,
      'register.specialCategories': true,
      'register.usesConsent': true,
      'register.usesContract': true,
      'register.usesLegitimateInterest': false,
    });
    expect(sheet.facts['register.activities']).toEqual([
      'newsletter',
      'orders',
      'sensitive_enquiries',
    ]);
    expect(sheet.facts['site.setsCookies']).toBeUndefined();
    expect(sheet.evidence.map((e) => e.evidenceId).sort()).toEqual(['form:1', 'form:2']);
    for (const name of Object.keys(sheet.facts)) expect(name in FACT_NAMES, name).toBe(true);
    const withSite = factsFrom({
      company,
      rows: [],
      findingTypeIds: ['CNS-01'],
      cookies: { total: 3, nonNecessary: 1 },
    });
    expect(withSite.facts).toMatchObject({
      'site.setsCookies': true,
      'site.setsNonNecessaryCookies': true,
      'site.findingTypes': ['CNS-01'],
    });
    // The fixture company on its own register gives the record-keeping duty and the notice duty.
    const duties = evaluate(sets, {
      caseId: 'DK-26-TEST',
      jurisdiction: 'DK',
      facts: sheet.facts,
      evidence: sheet.evidence,
    });
    const by = (id: string) => duties.find((d) => d.ruleId === id)!;
    expect(by('record-of-processing').status).toBe('applies');
    expect(by('information-at-collection').status).toBe('applies');
    expect(by('transfer-safeguards').status).toBe('not_applicable');
    expect(by('cookie-consent').status).toBe('undetermined');
    expect(by('dk-authority-named').status).toBe('applies');
    expect(
      by('record-of-processing')
        .because.evidence.map((e) => e.evidenceId)
        .sort(),
    ).toEqual(['form:1', 'form:2']);
  });
});

describe('the rule sets on disk', () => {
  it('load, speak in EU, DK and DE, and read only facts the sheet produces', () => {
    expect(sets.map((s) => s.jurisdiction)).toEqual(['DE', 'DK', 'EU']);
    expect(sets.find((s) => s.jurisdiction === 'EU')!.rules.length).toBeGreaterThanOrEqual(10);
    const known = new Set(Object.keys(FACT_NAMES));
    for (const f of factsUsed(sets)) expect(known.has(f), f).toBe(true);
  });

  it('every rule cites a provision that resolves in the corpus, and every example passes', () => {
    for (const set of sets) {
      for (const r of set.rules) {
        expect(r.citations.length, r.id).toBeGreaterThan(0);
        expect(r.examples.length, r.id).toBeGreaterThan(0);
        for (const c of citationsOf(r)) {
          const resolved = resolveInChunks(
            chunks,
            c,
            set.jurisdiction === 'EU' ? 'DK' : set.jurisdiction,
          );
          expect(resolved.ok, `${r.id}: ${c.ref}`).toBe(true);
        }
      }
    }
    const results = runExamples(sets);
    expect(results.length).toBeGreaterThan(20);
    expect(results.filter((x) => !x.ok)).toEqual([]);
    // Every status is shown somewhere: a reviewer sees each outcome worked.
    for (const status of ['applies', 'not_applicable', 'undetermined'] as const)
      expect(results.some((x) => x.expected === status)).toBe(true);
  });
});
