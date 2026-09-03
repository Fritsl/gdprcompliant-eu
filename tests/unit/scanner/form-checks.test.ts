import { describe, expect, it } from 'vitest';
import {
  FORM_CHECKS,
  FormObservationSchema,
  SUPPORTED_JURISDICTIONS,
  type FormRecord,
} from '@gc/contracts';
import { loadCatalogue } from '@gc/remedies';
import {
  FORM_PAGE_HINT,
  classifyField,
  collectsPersonalData,
  consentPurposes,
  evaluateForms,
  formSensitivity,
  noticeIn,
} from '@gc/scanner';

// The form rules without a browser (S-11): what a field is, what a checkbox is for,
// whether a notice is there, and what the three checks make of it all.

const field = (name: string, extra: Partial<Parameters<typeof classifyField>[0]> = {}) =>
  classifyField({ name, type: 'text', ...extra });

describe('field classification', () => {
  it('reads the most sensitive meaning from name, type, label, autocomplete or placeholder', () => {
    expect(field('kortnummer', { autocomplete: 'cc-number' })).toBe('financial');
    expect(field('card', { label: 'Card number' })).toBe('financial');
    expect(field('symptomer', { type: 'textarea', label: 'Beskriv dine symptomer' })).toBe(
      'health',
    );
    expect(field('x', { placeholder: 'Krankheit' })).toBe('health');
    expect(field('religion')).toBe('belief');
    expect(field('cpr')).toBe('identity');
    expect(field('birth', { label: 'Date of birth' })).toBe('identity');
    expect(field('pw', { type: 'password' })).toBe('credentials');
    expect(field('email', { type: 'email' })).toBe('contact');
    expect(field('f1', { autocomplete: 'given-name' })).toBe('contact');
    expect(field('besked', { type: 'textarea' })).toBe('free_text');
    expect(field('q')).toBe('other');
  });

  it('a form is as sensitive as its most sensitive field, and free text alone collects nothing', () => {
    expect(formSensitivity([{ category: 'contact' }, { category: 'financial' }])).toBe('financial');
    expect(formSensitivity([{ category: 'health' }, { category: 'financial' }])).toBe('special');
    expect(formSensitivity([{ category: 'identity' }, { category: 'contact' }])).toBe('identity');
    expect(formSensitivity([{ category: 'other' }, { category: 'free_text' }])).toBe('none');
    expect(collectsPersonalData([{ category: 'free_text' }, { category: 'other' }])).toBe(false);
    expect(collectsPersonalData([{ category: 'contact' }])).toBe(true);
  });
});

describe('consent controls and notices', () => {
  it('reads what a checkbox is for, in Danish, German and English', () => {
    expect(
      consentPurposes('Jeg accepterer handelsbetingelserne og vil gerne modtage nyhedsbrevet'),
    ).toEqual(['marketing', 'terms']);
    expect(consentPurposes('Ja tak, send mig nyhedsbrevet')).toEqual(['marketing']);
    expect(consentPurposes('Ich akzeptiere die AGB')).toEqual(['terms']);
    expect(consentPurposes('I have read the privacy policy')).toEqual(['privacy']);
    expect(consentPurposes('', 'newsletter_optin')).toEqual(['marketing']);
    expect(consentPurposes('Remember me')).toEqual(['other']);
  });

  it('finds a notice by link, by text, or not at all', () => {
    expect(noticeIn([{ href: '/privatlivspolitik.html', text: 'Læs mere' }], '')).toEqual({
      found: true,
      via: 'link',
      text: 'Læs mere',
    });
    expect(noticeIn([], 'Send. Vi behandler dine oplysninger i 12 måneder.')).toMatchObject({
      found: true,
      via: 'text',
    });
    expect(noticeIn([{ href: '/shop', text: 'Shop' }], 'Navn E-mail Send')).toEqual({
      found: false,
    });
  });

  it('knows which links are worth following for forms', () => {
    for (const p of ['/kontakt', '/checkout/', '/tilmeld.html', '/en/sign-up', '/konto/login']) {
      expect(FORM_PAGE_HINT.test(p), p).toBe(true);
    }
    for (const p of ['/', '/produkter/sko', '/om.html', '/blog/2026']) {
      expect(FORM_PAGE_HINT.test(p), p).toBe(false);
    }
  });
});

const ev = (n: number) => ({
  evidenceId: `text:${n.toString(16).padStart(16, '0')}`,
  hash: 'a'.repeat(64),
});
const record = (n: number, over: Partial<FormRecord>): FormRecord => ({
  page: `/p${n}`,
  index: 0,
  action: `https://x.dk/p${n}`,
  method: 'post',
  fields: [{ name: 'email', type: 'email', required: false, category: 'contact' }],
  controls: [],
  sensitivity: 'contact',
  notice: { found: true, via: 'link', text: 'Privatliv' },
  evidence: ev(n),
  ...over,
});
const box = (over: Partial<FormRecord['controls'][number]>): FormRecord['controls'][number] => ({
  name: 'nyhedsbrev',
  kind: 'checkbox',
  label: 'Ja tak til nyhedsbrevet',
  checkedInMarkup: false,
  checkedAfterScripts: false,
  hidden: false,
  required: false,
  purposes: ['marketing'],
  ...over,
});

describe('the three checks over records', () => {
  it('a pre-ticked box fails, whether ticked in the markup, by script, or hidden from view', () => {
    const forms = [
      record(1, { controls: [box({ id: 'a', checkedInMarkup: true, checkedAfterScripts: true })] }),
      record(2, { controls: [box({ id: 'b', checkedAfterScripts: true })] }),
      record(3, {
        controls: [
          box({ id: 'c', checkedInMarkup: true, checkedAfterScripts: true, hidden: true }),
        ],
      }),
      record(4, { controls: [box({ id: 'd' })] }),
    ];
    const o = evaluateForms(forms).find((x) => x.check === 'preticked')!;
    expect(o.outcome).toBe('fail');
    expect(o.findingTypeId).toBe(FORM_CHECKS.preticked);
    expect(o.severity).toBe('serious');
    expect(o.summary).toMatch(/3 consent box\(es\).*1 of them hidden.*1 ticked by script/);
    expect(
      (o.detail['controls'] as { id: string; setBy: string; hidden: boolean }[]).map((c) => [
        c.id,
        c.setBy,
        c.hidden,
      ]),
    ).toEqual([
      ['a', 'markup', false],
      ['b', 'script', false],
      ['c', 'markup', true],
    ]);
    expect(o.evidence).toEqual([ev(1), ev(2), ev(3)]);
  });

  it('a ticked terms box is not consent, and a marketing box the visitor ticks is fine', () => {
    const forms = [
      record(1, {
        controls: [box({ purposes: ['terms'], checkedInMarkup: true, checkedAfterScripts: true })],
      }),
      record(2, { controls: [box({ purposes: ['marketing'] })] }),
    ];
    const o = evaluateForms(forms);
    expect(o.map((x) => [x.check, x.outcome])).toEqual([
      ['preticked', 'pass'],
      ['bundled', 'pass'],
      ['no_notice', 'pass'],
    ]);
  });

  it('bundling is one box for marketing and terms, or a required marketing box', () => {
    const forms = [
      record(1, {
        controls: [box({ id: 'accept', purposes: ['marketing', 'terms'], required: true })],
      }),
      record(2, { controls: [box({ id: 'must', purposes: ['marketing'], required: true })] }),
      record(3, { controls: [box({ id: 'ok', purposes: ['marketing'] })] }),
    ];
    const o = evaluateForms(forms).find((x) => x.check === 'bundled')!;
    expect(o.outcome).toBe('fail');
    expect(o.severity).toBe('advisory');
    expect((o.detail['controls'] as { id: string }[]).map((c) => c.id)).toEqual(['accept', 'must']);
  });

  it('no notice at the point of collection fails, and sensitive fields make it blocking', () => {
    const contact = record(1, { notice: { found: false } });
    const search = record(2, {
      notice: { found: false },
      fields: [{ name: 'q', type: 'text', required: false, category: 'other' }],
      sensitivity: 'none',
    });
    const o1 = evaluateForms([contact, search]).find((x) => x.check === 'no_notice')!;
    expect(o1.outcome).toBe('fail');
    expect(o1.severity).toBe('serious');
    expect((o1.detail['forms'] as { page: string }[]).map((f) => f.page)).toEqual(['/p1']);

    const clinic = record(3, {
      notice: { found: false },
      fields: [{ name: 'symptomer', type: 'textarea', required: false, category: 'health' }],
      sensitivity: 'special',
    });
    const o2 = evaluateForms([contact, clinic]).find((x) => x.check === 'no_notice')!;
    expect(o2.severity).toBe('blocking');
    expect(o2.summary).toMatch(/2 form\(s\) collect personal data with no notice/);
    expect(o2.summary).toMatch(/\/p3 \(special: symptomer\)/);
  });

  it('an observation cannot fail without evidence, or map a check to the wrong finding', () => {
    const base = {
      check: 'preticked',
      findingTypeId: 'FRM-01',
      outcome: 'fail',
      severity: 'serious',
      summary: 'x',
    };
    expect(FormObservationSchema.safeParse(base).success).toBe(false);
    expect(FormObservationSchema.safeParse({ ...base, evidence: [ev(1)] }).success).toBe(true);
    expect(
      FormObservationSchema.safeParse({ ...base, findingTypeId: 'FRM-02', evidence: [ev(1)] })
        .success,
    ).toBe(false);
  });

  it('every check maps to a finding type with a remedy in every supported jurisdiction', () => {
    const catalogue = loadCatalogue();
    for (const [check, typeId] of Object.entries(FORM_CHECKS)) {
      for (const j of SUPPORTED_JURISDICTIONS) {
        expect(
          catalogue.forFinding(typeId, j).length,
          `${check} → ${typeId} in ${j}`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
