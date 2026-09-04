import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localise } from '@gc/i18n';
import { guideLocales, loadGuides } from '@gc/remedies';

// The guide pages (U-06), built and served: every guide is generated ahead of a request
// in each locale it is written in and in no other; the head names the page's canonical
// address and its translations; the text is the guide content and nothing else; every
// page ends in the scan form; the index links each guide in a language it exists in;
// and the sitemap and robots file list the public pages only.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const PORT = 3427;
const BASE = `http://127.0.0.1:${PORT}`;
const next = join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next');
const built = (locale: string, id?: string) =>
  join(WEB, '.next', 'server', 'app', locale, id ? join('guides', `${id}.html`) : 'guides.html');

const guides = loadGuides();
const SAMPLE = 'sec-03';

const decode = (s: string) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const attr = (html: string, tag: RegExp): string | undefined => {
  const m = tag.exec(html);
  return m?.[1] === undefined ? undefined : decode(m[1]);
};
const meta = (html: string, name: string) =>
  attr(html, new RegExp(`<meta name="${name}" content="([^"]*)"`));
const property = (html: string, name: string) =>
  attr(html, new RegExp(`<meta property="${name}" content="([^"]*)"`));
const canonical = (html: string) => attr(html, /<link rel="canonical" href="([^"]*)"/);
const alternates = (html: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<link rel="alternate" hreflang="([^"]*)" href="([^"]*)"/gi)) {
    out[m[1]!] = decode(m[2]!);
  }
  return out;
};
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

async function waitFor(target: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(target, { redirect: 'manual' });
      if (r.status < 500) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${target} did not come up: ${last}`);
}

describe('the guide pages (U-06)', () => {
  let server: ChildProcess | undefined;

  beforeAll(async () => {
    // The pages are rendered at build time with the origin the build was given, so a
    // build from another suite, or without this origin, is rebuilt.
    const sample = built('en', SAMPLE);
    const stale =
      !existsSync(sample) || !readFileSync(sample, 'utf8').includes(`${BASE}/en/guides/${SAMPLE}`);
    if (stale || process.env['GC_E2E_BUILD'] === '1') {
      const build = spawnSync(process.execPath, [next, 'build', '--webpack'], {
        cwd: WEB,
        stdio: 'pipe',
        encoding: 'utf8',
        env: { ...process.env, APP_BASE_URL: BASE },
      });
      if (build.status !== 0)
        throw new Error(`next build failed:\n${build.stdout}\n${build.stderr}`);
    }
    server = spawn(process.execPath, [next, 'start', '-p', String(PORT), '-H', '127.0.0.1'], {
      cwd: WEB,
      stdio: 'pipe',
      env: { ...process.env, APP_BASE_URL: BASE },
    });
    await waitFor(`${BASE}/en`, 60_000);
  }, 400_000);

  afterAll(() => {
    server?.kill();
  });

  it('every guide is generated ahead of a request, in each locale it is written in, and in no other', async () => {
    expect(guides.guides.length).toBeGreaterThanOrEqual(20);
    for (const g of guides.guides) {
      const locales = guideLocales(g);
      expect(locales, g.id).toContain('en');
      for (const l of ['en', 'da', 'de'] as const) {
        expect(existsSync(built(l, g.id)), `${l}/guides/${g.id}`).toBe(locales.includes(l));
      }
    }
    for (const l of ['en', 'da', 'de']) expect(existsSync(built(l)), `${l}/guides`).toBe(true);
    const missing = guides.guides.find((g) => !guideLocales(g).includes('de'));
    if (missing) {
      const r = await fetch(`${BASE}/de/guides/${missing.id}`);
      expect(r.status).toBe(404);
    }
    expect((await fetch(`${BASE}/en/guides/no-such-guide`)).status).toBe(404);
  });

  it('the head says where the page lives and where its translations are', async () => {
    const g = guides.byId(SAMPLE)!;
    for (const locale of ['en', 'da'] as const) {
      const html = await (await fetch(`${BASE}/${locale}/guides/${SAMPLE}`)).text();
      expect(html).toContain(`<html lang="${locale}"`);
      expect(canonical(html)).toBe(`${BASE}/${locale}/guides/${SAMPLE}`);
      const alt = alternates(html);
      for (const l of guideLocales(g)) expect(alt[l], l).toBe(`${BASE}/${l}/guides/${SAMPLE}`);
      expect(alt['x-default']).toBe(`${BASE}/en/guides/${SAMPLE}`);
      expect(Object.keys(alt).sort()).toEqual([...guideLocales(g), 'x-default'].sort());
      const title = localise(g.title, locale).value;
      expect(decode(/<title>([^<]*)<\/title>/.exec(html)![1]!)).toMatch(
        new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · `),
      );
      expect(meta(html, 'description')).toBe(localise(g.wrong, locale).value);
      expect(meta(html, 'keywords')).toContain(localise(g.keywords[0]!, locale).value);
      expect(property(html, 'og:url')).toBe(`${BASE}/${locale}/guides/${SAMPLE}`);
      expect(property(html, 'og:locale')).toBe(locale);
    }
  });

  it('the text is the guide content, rendered, and nothing else', async () => {
    for (const g of guides.guides.slice(0, 6)) {
      for (const locale of guideLocales(g).filter((l) => l !== 'de')) {
        const html = await (await fetch(`${BASE}/${locale}/guides/${g.id}`)).text();
        const body = text(html);
        for (const field of [g.title, g.wrong, g.why, g.confirm, ...g.steps]) {
          expect(body, `${g.id} ${locale}`).toContain(
            localise(field, locale).value.replace(/\s+/g, ' '),
          );
        }
        expect(html).toContain(`data-locales="${guideLocales(g).join(' ')}"`);
      }
    }
  });

  it('each page ends in the scan form, the same one as the front door', async () => {
    const front = await (await fetch(`${BASE}/da`)).text();
    const frontForm = /<form[^>]*data-scan-form=""[^>]*>[\s\S]*?<\/form>/.exec(front)![0];
    expect(frontForm).toContain('action="/da/scan"');
    for (const path of [`/da/guides/${SAMPLE}`, '/da/guides']) {
      const html = await (await fetch(`${BASE}${path}`)).text();
      const article = /<article[\s\S]*<\/article>/.exec(html)![0];
      const lastSection = article.lastIndexOf('<section');
      expect(article.slice(lastSection)).toContain('data-scan=""');
      expect(article.slice(lastSection)).toContain(frontForm);
      expect(article.slice(lastSection)).toContain('name="domain"');
    }
  });

  it('the index links every guide, in the reader’s language or the language it exists in', async () => {
    const en = await (await fetch(`${BASE}/en/guides`)).text();
    const ids = [...en.matchAll(/data-guide="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual(guides.guides.map((g) => g.id).sort());
    for (const g of guides.guides)
      expect(en).toMatch(new RegExp(`href="/en/guides/${g.id}" hreflang="en"`, 'i'));
    const de = await (await fetch(`${BASE}/de/guides`)).text();
    for (const g of guides.guides) {
      const served = guideLocales(g).includes('de') ? 'de' : 'en';
      expect(de).toMatch(new RegExp(`href="/${served}/guides/${g.id}" hreflang="${served}"`, 'i'));
      if (served !== 'de')
        expect(de).toMatch(new RegExp(`href="/en/guides/${g.id}" hreflang="en" lang="en"`, 'i'));
    }
    expect(canonical(de)).toBe(`${BASE}/de/guides`);
    expect(alternates(de)['x-default']).toBe(`${BASE}/en/guides`);
  });

  it('the sitemap lists the public pages with their translations, and robots keeps the rest out', async () => {
    const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
    expect(sitemap).toContain(`<loc>${BASE}/en/guides/${SAMPLE}</loc>`);
    expect(sitemap).toContain(`<loc>${BASE}/da/guides/${SAMPLE}</loc>`);
    expect(sitemap).toContain(`<loc>${BASE}/en/guides</loc>`);
    expect(sitemap).toContain(`<loc>${BASE}/da</loc>`);
    expect(sitemap).toMatch(new RegExp(`hreflang="da" href="${BASE}/da/guides/${SAMPLE}"`));
    expect(sitemap).toMatch(new RegExp(`hreflang="x-default" href="${BASE}/en/guides/${SAMPLE}"`));
    expect(sitemap).toContain(`<loc>${BASE}/de/guides/${SAMPLE}</loc>`);
    expect(sitemap).not.toMatch(/\/c\/|\/m\/|\/s\//);
    const robots = await (await fetch(`${BASE}/robots.txt`)).text();
    expect(robots).toContain('Disallow: /*/c/');
    expect(robots).toContain('Disallow: /*/m/');
    expect(robots).toContain('Disallow: /*/s/');
    expect(robots).toContain(`Sitemap: ${BASE}/sitemap.xml`);
  });
});
