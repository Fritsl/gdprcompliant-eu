import type { MetadataRoute } from 'next';
import { allLocales, guidePages, guideUrl, languagesOf } from '@/lib/guides';
import { siteUrl } from '@/lib/site';

// What a crawler may index (U-06): the front door, the guide index and every guide, in
// every locale each exists in, with the hreflang set on each row. Case, colleague and
// summary pages carry a secret in their address and are never listed.

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const locales = allLocales();
  const rows: MetadataRoute.Sitemap = [];
  const fronts: Record<string, string> = {};
  for (const l of locales) fronts[l] = `${base}/${l}`;
  fronts['x-default'] = `${base}/en`;
  for (const l of locales) {
    rows.push({
      url: `${base}/${l}`,
      changeFrequency: 'monthly',
      priority: 1,
      alternates: { languages: fronts },
    });
  }
  // Our own record (O-01): one page per language, generated from the configuration.
  const ourselves: Record<string, string> = {};
  for (const l of locales) ourselves[l] = `${base}/${l}/ourselves`;
  ourselves['x-default'] = `${base}/en/ourselves`;
  for (const l of locales) {
    rows.push({
      url: `${base}/${l}/ourselves`,
      changeFrequency: 'monthly',
      priority: 0.5,
      alternates: { languages: ourselves },
    });
  }
  // How the scanner behaves (D-11): the page its user agent points at.
  const scanner: Record<string, string> = {};
  for (const l of locales) scanner[l] = `${base}/${l}/scanner`;
  scanner['x-default'] = `${base}/en/scanner`;
  for (const l of locales) {
    rows.push({
      url: `${base}/${l}/scanner`,
      changeFrequency: 'monthly',
      priority: 0.5,
      alternates: { languages: scanner },
    });
  }
  const index = languagesOf(locales);
  for (const l of locales) {
    rows.push({
      url: guideUrl(l),
      changeFrequency: 'weekly',
      priority: 0.8,
      alternates: { languages: index },
    });
  }
  for (const page of guidePages()) {
    const languages = languagesOf(page.locales, page.id);
    for (const l of page.locales) {
      rows.push({
        url: guideUrl(l, page.id),
        changeFrequency: 'monthly',
        priority: 0.7,
        alternates: { languages },
      });
    }
  }
  return rows;
}
