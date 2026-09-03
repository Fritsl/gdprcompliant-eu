// Builds the single-file, self-contained prototype.
//   node apps/prototype/build.mjs
// Output: apps/prototype/dist/prototype.html — opens from disk, no server, no network
// beyond the Google Fonts stylesheet. That file is what gets published for review.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const css = readFileSync(join(HERE, 'styles.css'), 'utf8');
const js = readFileSync(join(HERE, 'app.js'), 'utf8');
const raw = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'companies', 'eksempelbutik.json'), 'utf8'));

// The fixture's leading comment is documentation for the repo, not for the page.
delete raw._comment;

// </script> inside JSON would close the tag early.
const data = JSON.stringify(raw).replace(/<\//g, '<\\/');

const html = `<title>GDPRcompliant.eu Prototype</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=Public+Sans:wght@400;500;600;700&display=swap">
<style>
${css}</style>
<div id="app"></div>
<script>window.PROTO_DATA=${data};</script>
<script>
${js}</script>
`;

mkdirSync(join(HERE, 'dist'), { recursive: true });
const out = join(HERE, 'dist', 'prototype.html');
writeFileSync(out, html, 'utf8');

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`built ${out}`);
console.log(`  ${kb} KB · ${raw.findings.length} findings · ${raw.timeline.length} timeline entries · ${raw.supplyChain.nodes.length} supply-chain nodes`);
