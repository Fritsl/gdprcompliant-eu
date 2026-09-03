// Smoke test for the prototype. Runs app.js against a minimal DOM stub and renders
// every screen, so a typo or a missing field in the fixture fails here rather than
// in front of Frits.
//   node apps/prototype/smoke.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const js = readFileSync(join(HERE, 'app.js'), 'utf8');
const data = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'companies', 'eksempelbutik.json'), 'utf8'));

let html = '';
const el = { set innerHTML(v) { html = v; }, get innerHTML() { return html; } };
const sandbox = {
  document: { getElementById: () => el },
  location: { hash: '' },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  console,
};
sandbox.window = sandbox;
sandbox.window.PROTO_DATA = data;
sandbox.window.scrollTo = () => {};

vm.createContext(sandbox);
vm.runInContext(js, sandbox, { filename: 'app.js' });

const SCREENS = ['front', 'scanning', 'case', 'finding', 'questions', 'colleagues', 'supply', 'artefact', 'trust', 'internal'];
const problems = [];
let checks = 0;

const assert = (cond, msg) => { checks++; if (!cond) problems.push(msg); };

for (const s of SCREENS) {
  sandbox.window.PROTO.go(s);
  const out = html;
  assert(out.length > 400, `${s}: rendered only ${out.length} chars`);
  assert(!/undefined|\[object Object\]|NaN/.test(out), `${s}: rendered undefined / [object Object] / NaN`);
  assert(out.includes('proto-badge'), `${s}: missing the PROTOTYPE marker`);
}

// Every finding must open, and must carry a remedy — the product's central rule.
for (const f of data.findings.concat([data.newInWatch])) {
  sandbox.window.PROTO.openFinding(f.id);
  assert(html.includes(f.id), `finding ${f.id}: id missing from its own page`);
  assert(html.includes('rem-card'), `finding ${f.id}: no remedy card rendered`);
  assert(!!f.remedy && !!f.remedy.kind, `finding ${f.id}: has no remedy — this must be impossible`);
}

// All three ages of the case must render, and closed counts must move the right way.
sandbox.window.PROTO.go('case');
const counts = {};
for (const age of ['fresh', 'working', 'watched']) {
  sandbox.window.PROTO.age(age);
  counts[age] = (html.match(/class="f-row/g) || []).length;
  assert(counts[age] > 0, `case/${age}: no findings rendered`);
}
assert(counts.watched >= counts.fresh, 'watched should surface at least as many rows as day one');

// The question flow must terminate rather than loop.
sandbox.window.PROTO.go('questions');
for (let i = 0; i < data.questions.length; i++) sandbox.window.PROTO.answer();
assert(/That is everything/.test(html), 'questions: flow does not reach its end state');

// Claim discipline (O-03) — none of these may appear in customer-facing copy.
sandbox.window.PROTO.go('trust');
for (const banned of ['certified', 'certificate', 'approved by', 'fully compliant', 'guaranteed']) {
  assert(!new RegExp(banned, 'i').test(html.replace(/never says approved[^<]*/i, '')), `trust page contains banned claim: "${banned}"`);
}

if (problems.length) {
  console.error(`\n✗ ${problems.length} problem(s) across ${checks} checks:\n`);
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
console.log(`✓ prototype smoke: ${checks} checks passed across ${SCREENS.length} screens and ${data.findings.length + 1} findings`);
