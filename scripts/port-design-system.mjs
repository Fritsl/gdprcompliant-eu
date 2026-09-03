#!/usr/bin/env node
// Port the prototype's design system to the web app, unchanged (U-01).
//
//   node scripts/port-design-system.mjs           write apps/web/app/design-system.css
//   node scripts/port-design-system.mjs --check   exit 1 if the app's copy has drifted
//
// apps/prototype/styles.css is the real design system. Everything ports byte for byte,
// except the `.proto-*` chrome, which is scaffolding for the clickthrough. A rule set is
// dropped only when every selector in it is prototype chrome.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SOURCE = fileURLToPath(new URL('../apps/prototype/styles.css', import.meta.url));
export const TARGET = fileURLToPath(new URL('../apps/web/app/design-system.css', import.meta.url));

const HEADER = `/* GDPRcompliant.eu — design system.
   Generated from apps/prototype/styles.css by scripts/port-design-system.mjs; do not edit
   here. The prototype is the design specification; its clickthrough chrome is left behind. */
`;

// Split a stylesheet into top-level chunks: comments, at-rules with blocks, rule sets.
function chunks(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    if (/\s/.test(css[i])) {
      i++;
      continue;
    }
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i) + 2;
      out.push({ kind: 'comment', text: css.slice(i, end) });
      i = end;
      continue;
    }
    // A rule set or at-rule: read up to the matching closing brace.
    const open = css.indexOf('{', i);
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) break;
    }
    const text = css.slice(i, j + 1);
    const selector = css.slice(i, open).trim();
    out.push({ kind: selector.startsWith('@') ? 'at' : 'rule', selector, text });
    i = j + 1;
  }
  return out;
}

const isProto = (selector) =>
  selector
    .split(',')
    .map((s) => s.trim())
    .every((s) => /(^|[\s>+~])\.proto-/.test(s) || s.startsWith('.proto-'));

export function port(css) {
  const kept = [];
  let dropComment = false;
  for (const c of chunks(css)) {
    if (c.kind === 'comment') {
      // The section banner for the prototype chrome goes with the chrome.
      if (/prototype chrome/.test(c.text)) {
        dropComment = true;
        continue;
      }
      if (/^\/\* GDPRcompliant\.eu — prototype design system/.test(c.text)) continue;
      kept.push(c.text);
      continue;
    }
    if (c.kind === 'rule' && isProto(c.selector)) continue;
    if (c.kind === 'at' && /^@media/.test(c.selector)) {
      // Prototype rules inside a media block go; the rest of the block stays.
      const openAt = c.text.indexOf('{');
      const inner = c.text.slice(openAt + 1, -1);
      const parts = chunks(inner);
      const keptInner = parts.filter((r) => !(r.kind === 'rule' && isProto(r.selector)));
      if (keptInner.filter((r) => r.kind !== 'comment').length === 0) continue;
      if (keptInner.length !== parts.length) {
        kept.push(c.text.slice(0, openAt + 1) + keptInner.map((r) => r.text).join('') + '}');
        continue;
      }
      dropComment = false;
      kept.push(c.text);
      continue;
    }
    dropComment = false;
    kept.push(c.text);
  }
  void dropComment;
  return `${HEADER}\n${kept.join('\n')}\n`;
}

const main = () => {
  const css = port(readFileSync(SOURCE, 'utf8'));
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(TARGET, 'utf8');
    } catch {
      // missing
    }
    if (current !== css) {
      console.error('apps/web/app/design-system.css has drifted from apps/prototype/styles.css — run node scripts/port-design-system.mjs');
      process.exit(1);
    }
    console.log('design system: in sync');
    return;
  }
  writeFileSync(TARGET, css);
  console.log(`design system: ${css.length} bytes written`);
};

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  main();
}
