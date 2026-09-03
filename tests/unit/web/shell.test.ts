import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LocalisedTextSchema } from '@gc/contracts';
import { SOURCE, TARGET, port } from '../../../scripts/port-design-system.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}
const components = [join(WEB, 'app'), join(WEB, 'components')].flatMap((d) => walk(d));
const rel = (f: string) => relative(ROOT, f).split(sep).join('/');

describe('the design system ports unchanged (U-01)', () => {
  const prototype = readFileSync(SOURCE, 'utf8');
  const app = readFileSync(TARGET, 'utf8');

  it('the app stylesheet is exactly the prototype stylesheet minus the prototype chrome', () => {
    expect(app).toBe(port(prototype));
    expect(app).not.toMatch(/\.proto-/);
  });

  it('carries every token, in both themes', () => {
    const tokens = [...prototype.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]);
    expect(new Set(tokens).size).toBeGreaterThan(30);
    for (const token of new Set(tokens)) expect(app, token).toContain(`${token}:`);
    expect(app).toMatch(
      /@media \(prefers-color-scheme: dark\)\{\s*:root:not\(\[data-theme="light"\]\)/,
    );
    expect(app).toMatch(/:root\[data-theme="dark"\]/);
  });

  it('the shell stylesheet uses tokens, never raw colours', () => {
    const shell = readFileSync(join(WEB, 'app', 'shell.css'), 'utf8');
    expect(shell).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(shell).not.toMatch(/rgba?\(/);
  });
});

describe('no hardcoded strings in components (U-01)', () => {
  const messages = JSON.parse(
    readFileSync(join(WEB, 'content', 'messages.json'), 'utf8'),
  ) as Record<string, unknown>;

  it('every UI string is a LocalisedText with English present', () => {
    expect(Object.keys(messages).length).toBeGreaterThan(5);
    for (const [key, value] of Object.entries(messages)) {
      expect(LocalisedTextSchema.safeParse(value).success, key).toBe(true);
    }
  });

  it('no JSX text node or user-facing attribute carries a literal', () => {
    const textNode = />\s*[A-Za-zÀ-ÿ][^<>{}]*</;
    const attribute = /\b(?:aria-label|title|placeholder|alt|aria-description)=["'][^"']*[A-Za-z]/;
    const offenders = components
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => ({ file: rel(f), src: readFileSync(f, 'utf8') }))
      .filter(({ src }) => textNode.test(src) || attribute.test(src))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('every key a component asks for exists, and every key is asked for', () => {
    const used = new Set<string>();
    for (const f of components) {
      for (const m of readFileSync(f, 'utf8').matchAll(
        /\bt\(\s*\w+\s*,\s*'([A-Za-z0-9.]+)'\s*\)/g,
      )) {
        used.add(m[1]!);
      }
    }
    expect([...used].sort()).toEqual(Object.keys(messages).sort());
  });
});

describe('locale is a route segment (U-01)', () => {
  const layout = readFileSync(join(WEB, 'app', '[locale]', 'layout.tsx'), 'utf8');
  const root = readFileSync(join(WEB, 'app', 'page.tsx'), 'utf8');

  it('the segments are generated from the content locale list, and nothing else is served', () => {
    expect(layout).toMatch(
      /generateStaticParams\(\)\s*\{\s*return localeCodes\.map\(\(locale\) => \(\{ locale \}\)\)/,
    );
    expect(layout).toMatch(/export const dynamicParams = false/);
    expect(layout).toMatch(/<html lang=\{locale\}>/);
  });

  it('the root only redirects into a locale', () => {
    expect(root).toMatch(/redirect\(`\/\$\{wanted \?\? defaultLocale\}`\)/);
    expect(root).not.toMatch(/return\s*\(?\s*</);
  });

  it('no component reaches for a locale list of its own', () => {
    for (const f of components) {
      expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/\[\s*'en'\s*,\s*'da'/);
    }
  });
});
