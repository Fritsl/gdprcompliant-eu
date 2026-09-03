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
  counts[age] = (html.match(/class="step /g) || []).length;
  assert(counts[age] > 0, `case/${age}: no findings rendered`);
}
assert(counts.watched > counts.fresh, 'watched should add the new step the weekly watch found');

for (const age of ['fresh','working','watched']) {
  sandbox.window.PROTO.age(age);
  const now = (html.match(/class=\"step now\"/g) || []).length;
  assert(now === 1, `case/${age}: expected exactly one current step, found ${now}`);
  const primaries = (html.match(/class=\"btn\"/g) || []).length;
  assert(primaries <= 1, `case/${age}: ${primaries} primary buttons — the page must offer one next action`);
}

// A site with nothing non-essential before consent must not be told off for having no
// banner. gdprchat.eu is exactly this case: no cookies, so no banner, and that is correct.
for (const [name, o] of Object.entries(data.scanOutcomes)) {
  sandbox.window.PROTO.go('scanning');
  sandbox.window.PROTO.outcome(name);
  for (let i = 0; i < 12; i++) sandbox.window.PROTO.tick();
  assert(html.includes(o.headline), `scan/${name}: outcome headline not shown`);
  if (o.clean) {
    assert(/not needed/.test(html), `scan/${name}: must mark the banner checks not needed, not failed`);
    assert(!/could not tell|no response/.test(html), `scan/${name}: a clean site must not read as a failed test`);
    assert(/scan-out good/.test(html), `scan/${name}: a correct result must not be styled as a problem`);
  }
}
sandbox.window.PROTO.outcome('clean');

// The question flow must terminate rather than loop.
sandbox.window.PROTO.go('questions');
for (let i = 0; i < data.questions.length; i++) sandbox.window.PROTO.answer();
assert(/That is everything/.test(html), 'questions: flow does not reach its end state');

// A question is one question and nothing else. Anything we already know goes in
// `context`, rendered separately, so the reader is never handed a statement and a
// question in the same breath. This matters more once the planner writes these
// rather than a human.
for (const q of data.questions) {
  assert(/^[^.!?]*\?$/.test(q.text.trim()), `${q.id}: the question field must hold only the question — move the statement to context`);
  if (q.context) {
    assert(!q.context.includes('?'), `${q.id}: context must not ask anything`);
  }
  // And the options must actually answer what was asked.
  const wantsYesNo = /^(do|does|did|is|are|was|were|have|has|had|can|could|will|would|should)\b/i.test(q.text.trim());
  const offersYesNo = q.options.some((o) => /^yes$/i.test(o)) && q.options.some((o) => /^no$/i.test(o));
  assert(
    wantsYesNo === offersYesNo,
    `${q.id}: "${q.text}" ${wantsYesNo ? 'takes Yes/No but is not offered them' : 'is not a yes/no question but offers Yes/No'}`
  );
  assert(q.options.length >= 2 && q.options.length <= 4, `${q.id}: ${q.options.length} options — keep it to a tap`);
}

// Copy discipline. Text that points at the interface, or narrates what the adjacent
// control does, is dead weight — the control is right there. Checked against the product
// screens only; the .proto-* chrome is scaffolding and may describe itself.
const NARRATION = [
  'below', 'above', 'on this page', 'you just need', 'simply click',
  'as you can see', 'this page shows', 'what you see here',
];
for (const s of SCREENS) {
  sandbox.window.PROTO.go(s);
  const product = html.slice(html.indexOf('<div class="screen'));
  const text = product.replace(/<pre[\s\S]*?<\/pre>/g, ' ').replace(/<[^>]+>/g, ' ');
  for (const phrase of NARRATION) {
    assert(!text.toLowerCase().includes(phrase), `${s}: copy points at the interface — "${phrase}"`);
  }
}

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
