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

const SCREENS = ['front', 'scanning', 'case', 'finding', 'questions', 'colleagues', 'supply', 'artefact', 'trust', 'report', 'advisor', 'internal'];
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

// Verbatim guarantee. Every article the product shows must resolve to the corpus and be
// reproduced character for character — this is the prototype stand-in for T-03. A model
// must never be the thing that types an article number or its text.
const quoted = new Set([...data.report.articlesUsed, ...data.advisor.thread.filter(m => m.law).map(m => m.law)]);
for (const key of quoted) {
  const art = data.articles[key];
  assert(!!art, `${key}: quoted but not in the corpus`);
  if (!art) continue;
  assert(art.text.length > 80, `${key}: corpus text looks truncated`);
  assert(art.ref.startsWith('Regulation (EU) 2016/679, Article '), `${key}: reference is not a resolvable citation`);
}
// What the prototype can actually prove is that the renderer never mangles a quote:
// every blockquote it emits must equal a corpus entry exactly — not truncated, not
// ellipsised, not annotated inside the quotation. Proving the text is *genuine* needs a
// second independent source and belongs to T-03, which compares corpus against output.
const corpusTexts = new Set(Object.values(data.articles).map((a) => a.text));
for (const screen of ['report', 'advisor']) {
  sandbox.window.PROTO.go(screen);
  const blocks = [...html.matchAll(/<blockquote>([\s\S]*?)<\/blockquote>/g)].map((m) =>
    m[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  );
  assert(blocks.length > 0, `${screen}: no law quoted at all`);
  for (const b of blocks) {
    assert(corpusTexts.has(b), `${screen}: a quoted passage does not match the corpus exactly — the renderer altered it`);
  }
}

// Dive points: every dive opens, quotes the fragment it was opened from, grounds the
// answer in the case, and offers a way onward. Gating means a dive never exists for
// something with nothing to expand.
for (const key of Object.keys(data.dives)) {
  const v = data.dives[key];
  sandbox.window.PROTO.dive(key);
  assert(/class="dv"/.test(html), `dive/${key}: overlay did not open`);
  assert(html.includes(data.diveDefaults.opener), `dive/${key}: turn zero is missing the opener`);
  assert(html.includes(v.fragment.slice(0, 40)), `dive/${key}: the fragment it was opened from is not shown`);
  assert(/class="ground"/.test(html), `dive/${key}: the answer is not grounded in the case`);
  assert(v.followups.length > 0, `dive/${key}: offers no way onward`);
  assert(v.fragment.length <= 300, `dive/${key}: fragment is ${v.fragment.length} chars — the cap is 300`);
  if (data.articles[v.law]) {
    assert(html.includes(data.articles[v.law].text), `dive/${key}: law is not quoted verbatim`);
  }
}
sandbox.window.PROTO.closeDive();
assert(!/class="dv"/.test(html), 'dive: overlay did not close');

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
