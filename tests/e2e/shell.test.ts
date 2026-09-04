import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import lighthouse from 'lighthouse';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The shell, in a real browser: server-rendered under a locale segment, both themes at
// token level, the fallback visible, and Lighthouse accessibility at 95 or better.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const ARTIFACTS = join(ROOT, 'artifacts');
const PORT = 3417;
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = 9333;

// Token values from apps/prototype/styles.css. If these change, the design changed.
const PAPER = { light: '#f4f6fa', dark: '#0a1019' };

let server: ChildProcess | undefined;
let browser: Browser;

const next = join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next');

async function waitFor(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status < 500) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up: ${last}`);
}

beforeAll(async () => {
  mkdirSync(ARTIFACTS, { recursive: true });
  if (!existsSync(join(WEB, '.next', 'BUILD_ID')) || process.env['GC_E2E_BUILD'] === '1') {
    const build = spawnSync(process.execPath, [next, 'build', '--webpack'], {
      cwd: WEB,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (build.status !== 0) throw new Error(`next build failed:\n${build.stdout}\n${build.stderr}`);
  }
  server = spawn(process.execPath, [next, 'start', '-p', String(PORT), '-H', '127.0.0.1'], {
    cwd: WEB,
    stdio: 'pipe',
  });
  await waitFor(`${BASE}/en`, 60_000);
  browser = await chromium.launch({ args: [`--remote-debugging-port=${DEBUG_PORT}`] });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
});

describe('locale-prefixed routes, server-rendered', () => {
  it('the root sends the visitor to the locale the browser asks for, or English', async () => {
    const plain = await fetch(`${BASE}/`, { redirect: 'manual' });
    expect([307, 308]).toContain(plain.status);
    expect(plain.headers.get('location')).toMatch(/\/en$/);

    const danish = await fetch(`${BASE}/`, {
      redirect: 'manual',
      headers: { 'accept-language': 'da-DK,da;q=0.9,en;q=0.8' },
    });
    expect(danish.headers.get('location')).toMatch(/\/da$/);
  });

  it('each locale renders on the server, with its lang attribute and its text in the HTML', async () => {
    for (const [locale, heading] of [
      ['en', 'Is your website GDPR compliant?'],
      ['da', 'Overholder din hjemmeside GDPR?'],
    ] as const) {
      const r = await fetch(`${BASE}/${locale}`);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain(`<html lang="${locale}"`);
      expect(html).toContain(heading);
      expect(html).toMatch(/<main[^>]*id="content"/);
      expect(html).toMatch(/<header/);
      expect(html).toMatch(/<footer/);
    }
  });

  it('an unknown locale is a 404, not a fallback', async () => {
    expect((await fetch(`${BASE}/xx`)).status).toBe(404);
  });

  it('a string the locale lacks falls back to English visibly', async () => {
    const html = await (await fetch(`${BASE}/de`)).text();
    expect(html).toMatch(/<h1 lang="en" data-fallback="">Is your website GDPR compliant\?<\/h1>/);
    const english = await (await fetch(`${BASE}/en`)).text();
    expect(english).not.toContain('data-fallback');
  });
});

describe('both themes, at token level', () => {
  const paper = async (page: import('playwright').Page) =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
    );

  it('follows the system by default and the attribute when set', async () => {
    const page = await browser.newPage();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${BASE}/en`);
    expect(await paper(page)).toBe(PAPER.light);
    await page.screenshot({ path: join(ARTIFACTS, 'shell-light.png'), fullPage: true });

    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await paper(page)).toBe(PAPER.dark);
    await page.screenshot({ path: join(ARTIFACTS, 'shell-dark.png'), fullPage: true });

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    expect(await paper(page)).toBe(PAPER.light);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    expect(await paper(page)).toBe(PAPER.dark);
    await page.close();
  });

  it('the toggle persists the choice and it applies before first paint on reload', async () => {
    const page = await browser.newPage();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${BASE}/en`);
    await page.getByRole('radio', { name: 'Dark' }).check();
    expect(await page.getAttribute('html', 'data-theme')).toBe('dark');
    expect(await paper(page)).toBe(PAPER.dark);
    await page.reload();
    expect(await page.getAttribute('html', 'data-theme')).toBe('dark');
    await page.getByRole('radio', { name: 'System' }).check();
    expect(await page.getAttribute('html', 'data-theme')).toBeNull();
    await page.close();
  });
});

describe('accessibility', () => {
  it('Lighthouse accessibility is 95 or better on the shell', async () => {
    const result = await lighthouse(`${BASE}/en`, {
      port: DEBUG_PORT,
      output: 'json',
      onlyCategories: ['accessibility'],
      logLevel: 'error',
    });
    expect(result).toBeDefined();
    const report = result!.lhr;
    writeFileSync(join(ARTIFACTS, 'lighthouse-shell.json'), JSON.stringify(report, null, 2));
    const score = (report.categories['accessibility']?.score ?? 0) * 100;
    const failing = Object.values(report.audits)
      .filter((a) => a.score !== null && a.score < 1 && a.scoreDisplayMode !== 'notApplicable')
      .map((a) => `${a.id}: ${a.title}`);
    expect(score, failing.join('\n')).toBeGreaterThanOrEqual(95);
  }, 120_000);
});
