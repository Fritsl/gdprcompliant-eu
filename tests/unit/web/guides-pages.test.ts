import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { guideLocales, loadGuides } from '@gc/remedies';

// The guide pages (U-06), at the source: generated ahead of a request, never on demand;
// one scan form shared with the front door; and every guide written in full in English
// and Danish, so the static parameter set is what the content says it is.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const src = (...p: string[]) => readFileSync(join(ROOT, 'apps', 'web', ...p), 'utf8');

describe('the guide pages are static', () => {
  const page = src('app', '[locale]', 'guides', '[id]', 'page.tsx');
  const index = src('app', '[locale]', 'guides', 'page.tsx');

  it('neither page opts into rendering on demand, and the guide page fixes its parameter set', () => {
    for (const s of [page, index]) expect(s).not.toContain('force-dynamic');
    expect(page).toContain('export const dynamicParams = false;');
    expect(page).toContain('export function generateStaticParams');
    for (const s of [page, index]) {
      expect(s).toContain('generateMetadata');
      expect(s).toContain('alternates: { canonical: url, languages:');
    }
  });

  it('the front door and both guide pages end in the same scan form', () => {
    const front = src('app', '[locale]', 'page.tsx');
    // The front door may hand the form a referral code (L-04); the guides never do.
    for (const s of [page, index]) expect(s).toContain('<ScanForm locale={locale} />');
    expect(front).toContain('<ScanForm locale={locale} {...(referral ? { referral } : {})} />');
    expect(front).not.toContain('<form');
    const form = src('components', 'ScanForm.tsx');
    expect(form).toContain('action={`/${locale}/scan`}');
    expect(form).toContain('name="domain"');
  });

  it('the sitemap and robots file exist and build from the one origin helper', () => {
    for (const f of ['sitemap.ts', 'robots.ts'])
      expect(src('app', f)).toContain("from '@/lib/site'");
    expect(src('lib', 'case.ts')).toContain('appBaseUrl = siteUrl');
  });
});

describe('the guide content decides the pages', () => {
  it('every guide is written in full in English and Danish', () => {
    const guides = loadGuides();
    expect(guides.guides.length).toBeGreaterThanOrEqual(20);
    for (const g of guides.guides) expect(guideLocales(g), g.id).toEqual(['en', 'da', 'de']);
    expect(guides.completeLocales()).toEqual(['en', 'da', 'de']);
  });
});
