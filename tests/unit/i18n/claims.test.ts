import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER } from '@gc/artefacts';
import { loadDecisions } from '@gc/corpus';
import { loadBindingTables } from '@gc/findings';
import { LOCALES, auditClaims, bannedClaims, contentFiles, loadClaimVocabulary } from '@gc/i18n';

// Claim discipline (O-03): the vocabulary catches the claims the product never makes, in
// each locale; the brand and ordinary words pass; the allowances are exact; the live
// content set is clean; and a finding about a third party cites a decision everywhere.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const vocab = loadClaimVocabulary();

describe('the banned vocabulary', () => {
  it('catches a certificate, an approval, a verdict, a guarantee, a seal and an accusation', () => {
    const en = (s: string) => bannedClaims(s, 'en', vocab).map((h) => h.match);
    expect(en('Your site is now certified.')).toEqual(['certified']);
    expect(en('Approved by our reviewers')).toEqual(['Approved']);
    expect(en('The shop is GDPR compliant')).toEqual(['compliant']);
    expect(en('We guarantee a clean scan')).toEqual(['guarantee']);
    expect(en('Show the seal on your footer')).toEqual(['seal']);
    expect(en('Google Analytics is unlawful in Denmark')).toEqual(['unlawful']);
    expect(en('The site violates the rules')).toEqual(['violates']);
  });

  it('speaks Danish and German', () => {
    expect(bannedClaims('Butikken er nu certificeret', 'da', vocab).map((h) => h.match)).toEqual([
      'certificeret',
    ]);
    expect(bannedClaims('Godkendt af os', 'da', vocab).map((h) => h.match)).toEqual(['Godkendt']);
    expect(bannedClaims('Værktøjet er ulovligt', 'da', vocab).map((h) => h.match)).toEqual([
      'ulovligt',
    ]);
    expect(bannedClaims('Ihre Website ist DSGVO-konform', 'de', vocab).map((h) => h.match)).toEqual(
      ['DSGVO-konform'],
    );
    expect(bannedClaims('Das ist rechtswidrig', 'de', vocab).map((h) => h.match)).toEqual([
      'rechtswidrig',
    ]);
  });

  it('lets the brand, compliance as a subject, and a colleague approving a document through', () => {
    expect(bannedClaims('GDPRcompliant.eu looks every week', 'en', vocab)).toEqual([]);
    expect(bannedClaims('Compliance is a process, not a state', 'en', vocab)).toEqual([]);
    expect(bannedClaims('Approve this document', 'en', vocab)).toEqual([]);
    expect(bannedClaims('The CSP report lists violations', 'en', vocab)).toEqual([]);
    expect(bannedClaims('Godkend dokumentet', 'da', vocab)).toEqual([]);
    expect(bannedClaims('Bemærk fristen', 'da', vocab)).toEqual([]);
    // A pattern belongs to its locale: English words in Danish text are not judged twice.
    expect(bannedClaims('certified', 'da', vocab)).toEqual([]);
  });
});

describe('the audit', () => {
  it('reports a hit with its file, path and locale, and allows only an exact file and path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claims-'));
    const file = join(dir, 'copy.json');
    writeFileSync(
      file,
      JSON.stringify({
        ok: { en: 'Nothing here is a verdict.', da: 'Intet her er en dom.' },
        bad: { en: 'You are now certified.', da: 'Du er nu certificeret.' },
        nested: [{ deep: { en: 'Approved!', da: 'Fint.' } }],
      }),
    );
    const audit = auditClaims(dir, [file], { ...vocab, allow: [] });
    expect(audit.strings).toBe(3);
    expect(audit.problems.map((p) => `${p.path} ${p.locale} ${p.match}`)).toEqual([
      'bad en certified',
      'bad da certificeret',
      'nested[0].deep en Approved',
    ]);
    const allowed = auditClaims(dir, [file], {
      ...vocab,
      allow: [
        { file: 'copy.json', path: 'bad', why: 'a test' },
        { file: 'copy.json', path: 'other', why: 'stale' },
      ],
    });
    expect(allowed.problems.map((p) => p.path)).toEqual(['nested[0].deep']);
    expect(allowed.unusedAllowances.map((a) => a.path)).toEqual(['other']);
  });

  it('finds the content set, without the corpus, and the live content is clean', () => {
    const files = contentFiles(ROOT);
    expect(
      files.some((f) => f.replace(/\\/g, '/').endsWith('apps/web/content/messages.json')),
    ).toBe(true);
    expect(
      files.some((f) => f.replace(/\\/g, '/').includes('packages/remedies/content/guides/')),
    ).toBe(true);
    expect(files.some((f) => f.replace(/\\/g, '/').includes('packages/corpus/content/'))).toBe(
      false,
    );
    const audit = auditClaims(ROOT, files, vocab);
    expect(audit.problems).toEqual([]);
    expect(audit.unusedAllowances).toEqual([]);
    expect(audit.strings).toBeGreaterThan(500);
  });
});

describe('third parties and the disclaimer', () => {
  it('every finding about a third party cites a decision the registry knows, in every jurisdiction', () => {
    const known = new Set(loadDecisions().decisions.map((d) => `${d.body}:${d.reference}`));
    const tables = loadBindingTables();
    expect(tables.size).toBeGreaterThanOrEqual(2);
    for (const [jurisdiction, table] of tables) {
      for (const type of ['TRF-01', 'VND-06']) {
        const row = table.bindings.find((b) => b.findingTypeId === type)!;
        const decisions = row.citations.filter((c) => /^case law$/i.test(c.instrument));
        expect(decisions.length, `${jurisdiction} ${type}`).toBeGreaterThan(0);
        for (const c of decisions) {
          const m = /^([^,]+),\s*(.+)$/.exec(c.ref)!;
          expect(
            known.has(`${m[1]!.trim()}:${m[2]!.trim()}`),
            `${jurisdiction} ${type} ${c.ref}`,
          ).toBe(true);
        }
      }
    }
  });

  it('the disclaimer speaks every locale and denies the claims it names', () => {
    for (const l of LOCALES) {
      const text = DISCLAIMER[l.code];
      expect(text, l.code).toBeTruthy();
      expect(text!.length).toBeGreaterThan(80);
    }
    expect(DISCLAIMER.en).toMatch(/not a certification/);
    expect(DISCLAIMER.en).toMatch(/not a legal opinion/);
  });
});
