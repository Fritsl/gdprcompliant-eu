#!/usr/bin/env node
// Task coordination for GDPRcompliant.eu.
//
// One file per task under tasks/. Claiming, working and completing a task touches
// exactly one file, so two agents working in parallel never collide in git.
//
//   node scripts/tasks.mjs init                 generate missing task files from _seed.mjs
//   node scripts/tasks.mjs board                status overview, grouped by phase
//   node scripts/tasks.mjs next [--stream S]    tasks that are claimable right now
//   node scripts/tasks.mjs show <id>            print one task
//   node scripts/tasks.mjs claim <id> --as <who>
//   node scripts/tasks.mjs done <id> [--note "..."]
//   node scripts/tasks.mjs block <id> --reason "..."
//   node scripts/tasks.mjs release <id>
//   node scripts/tasks.mjs check                integrity: unknown deps, cycles, orphans

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS_DIR = join(ROOT, 'tasks');
const STATUSES = ['todo', 'doing', 'blocked', 'done'];

const C = process.stdout.isTTY
  ? { d: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', x: '\x1b[0m' }
  : { d: '', b: '', g: '', y: '', r: '', c: '', x: '' };

const STATUS_STYLE = { todo: C.d, doing: C.y, blocked: C.r, done: C.g };
const MARK = { todo: ' ', doing: '~', blocked: '!', done: 'x' };

// ---------------------------------------------------------------- task files

/** Flat `key: value` frontmatter. Deliberately not YAML — no dependency, no ambiguity. */
function parseTask(text, file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file}: missing frontmatter block`);
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${file}: cannot parse frontmatter line: ${line}`);
    meta[kv[1]] = kv[2].trim();
  }
  meta.depends = meta.depends ? meta.depends.split(',').map((s) => s.trim()).filter(Boolean) : [];
  meta.phase = Number(meta.phase);
  return { meta, body: m[2], file };
}

function serialise(task) {
  const m = task.meta;
  const order = ['id', 'title', 'stream', 'phase', 'est', 'status', 'owner', 'claimed', 'completed', 'depends', 'verify'];
  const lines = order
    .filter((k) => m[k] !== undefined && m[k] !== '')
    .map((k) => `${k}: ${k === 'depends' ? m.depends.join(', ') : m[k]}`);
  return `---\n${lines.join('\n')}\n---\n${task.body}`;
}

function loadAll() {
  if (!existsSync(TASKS_DIR)) return [];
  return readdirSync(TASKS_DIR)
    .filter((f) => /^[A-Z]-\d+\.md$/.test(f))
    .map((f) => parseTask(readFileSync(join(TASKS_DIR, f), 'utf8'), f))
    .sort((a, b) => a.meta.phase - b.meta.phase || a.meta.id.localeCompare(b.meta.id));
}

function save(task) {
  writeFileSync(join(TASKS_DIR, task.file), serialise(task), 'utf8');
}

function find(tasks, id) {
  const t = tasks.find((t) => t.meta.id.toLowerCase() === String(id).toLowerCase());
  if (!t) fail(`no such task: ${id}`);
  return t;
}

const fail = (msg) => {
  console.error(`${C.r}error${C.x} ${msg}`);
  process.exit(1);
};

const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

// ---------------------------------------------------------------- commands

async function init() {
  const seed = await import(new URL('../tasks/_seed.mjs', import.meta.url).href);
  mkdirSync(TASKS_DIR, { recursive: true });
  let made = 0;
  for (const t of seed.tasks) {
    const file = join(TASKS_DIR, `${t.id}.md`);
    if (existsSync(file)) continue;
    const body = [
      `# ${t.id} · ${t.title}`,
      '',
      '## Goal',
      t.goal,
      '',
      '## Acceptance criteria',
      ...t.acceptance.map((a) => `- [ ] ${a}`),
      '',
      '## How this is verified',
      '```bash',
      t.verify,
      '```',
      ...(t.notes ? ['', '## Notes', t.notes] : []),
      '',
      '## Log',
      '<!-- Append one line per meaningful event. Do not rewrite history. -->',
      '',
    ].join('\n');
    writeFileSync(
      file,
      serialise({
        meta: {
          id: t.id, title: t.title, stream: t.stream, phase: t.phase, est: t.est,
          status: 'todo', depends: t.depends ?? [], verify: t.verify,
        },
        body,
      }),
      'utf8',
    );
    made++;
  }
  console.log(`${C.g}init${C.x} ${made} task file(s) created, ${seed.tasks.length - made} already present`);
}

function claimable(tasks) {
  const done = new Set(tasks.filter((t) => t.meta.status === 'done').map((t) => t.meta.id));
  return tasks.filter(
    (t) => t.meta.status === 'todo' && t.meta.depends.every((d) => done.has(d)),
  );
}

function board(tasks) {
  const byPhase = new Map();
  for (const t of tasks) {
    if (!byPhase.has(t.meta.phase)) byPhase.set(t.meta.phase, []);
    byPhase.get(t.meta.phase).push(t);
  }
  const total = tasks.length;
  const doneN = tasks.filter((t) => t.meta.status === 'done').length;
  for (const [phase, list] of [...byPhase].sort((a, b) => a[0] - b[0])) {
    const d = list.filter((t) => t.meta.status === 'done').length;
    console.log(`\n${C.b}Phase ${phase}${C.x} ${C.d}${d}/${list.length}${C.x}`);
    for (const t of list) {
      const s = t.meta.status;
      const who = t.meta.owner ? ` ${C.c}@${t.meta.owner}${C.x}` : '';
      const blocked = s === 'todo' && !claimable(tasks).includes(t) ? ` ${C.d}(waiting)${C.x}` : '';
      console.log(`  ${STATUS_STYLE[s]}[${MARK[s]}]${C.x} ${t.meta.id.padEnd(5)} ${t.meta.title}${who}${blocked}`);
    }
  }
  console.log(`\n${C.b}${doneN}/${total}${C.x} done · ${claimable(tasks).length} claimable now\n`);
}

function show(tasks, id) {
  const t = find(tasks, id);
  console.log(serialise(t));
}

function next(tasks, stream) {
  let list = claimable(tasks);
  if (stream) list = list.filter((t) => t.meta.stream === stream.toUpperCase());
  if (!list.length) return console.log('nothing claimable — check `board` for what is blocking');
  for (const t of list) {
    console.log(`${C.g}${t.meta.id.padEnd(5)}${C.x} ${t.meta.title} ${C.d}(${t.meta.est}, phase ${t.meta.phase})${C.x}`);
  }
}

function log(task, line) {
  task.body = task.body.replace(/\n*$/, `\n- ${now()} — ${line}\n`);
}

function claim(tasks, id, who) {
  if (!who) fail('claim needs --as <name>, so we know who is holding it');
  const t = find(tasks, id);
  if (t.meta.status === 'done') fail(`${t.meta.id} is already done`);
  if (t.meta.status === 'doing') fail(`${t.meta.id} is held by ${t.meta.owner}. Use \`release\` first if that is stale.`);
  const done = new Set(tasks.filter((x) => x.meta.status === 'done').map((x) => x.meta.id));
  const missing = t.meta.depends.filter((d) => !done.has(d));
  if (missing.length) fail(`${t.meta.id} depends on unfinished work: ${missing.join(', ')}`);
  t.meta.status = 'doing';
  t.meta.owner = who;
  t.meta.claimed = now();
  log(t, `claimed by ${who}`);
  save(t);
  console.log(`${C.y}claimed${C.x} ${t.meta.id} — ${t.meta.title}\n\nVerify with:\n  ${t.meta.verify}\n`);
}

function done(tasks, id, note) {
  const t = find(tasks, id);
  if (t.meta.status !== 'doing') fail(`${t.meta.id} is ${t.meta.status}; claim it before completing it`);
  const unchecked = (t.body.match(/^- \[ \] /gm) || []).length;
  if (unchecked) fail(`${t.meta.id} has ${unchecked} unticked acceptance criteria. Tick them in the file, or use \`block\` and say why.`);
  t.meta.status = 'done';
  t.meta.completed = now();
  log(t, `done${note ? ` — ${note}` : ''}`);
  save(t);
  const unlocked = claimable(tasks).filter((x) => x.meta.depends.includes(t.meta.id));
  console.log(`${C.g}done${C.x} ${t.meta.id}`);
  if (unlocked.length) console.log(`unlocked: ${unlocked.map((x) => x.meta.id).join(', ')}`);
}

function block(tasks, id, reason) {
  if (!reason) fail('block needs --reason "..."');
  const t = find(tasks, id);
  t.meta.status = 'blocked';
  log(t, `blocked — ${reason}`);
  save(t);
  console.log(`${C.r}blocked${C.x} ${t.meta.id} — ${reason}`);
}

function release(tasks, id) {
  const t = find(tasks, id);
  if (t.meta.status === 'done') fail('cannot release a finished task');
  t.meta.status = 'todo';
  const was = t.meta.owner;
  delete t.meta.owner;
  delete t.meta.claimed;
  log(t, `released${was ? ` by ${was}` : ''}`);
  save(t);
  console.log(`released ${t.meta.id}`);
}

function check(tasks) {
  const ids = new Set(tasks.map((t) => t.meta.id));
  const problems = [];
  for (const t of tasks) {
    if (!STATUSES.includes(t.meta.status)) problems.push(`${t.meta.id}: bad status "${t.meta.status}"`);
    if (t.meta.status === 'doing' && !t.meta.owner) problems.push(`${t.meta.id}: doing with no owner`);
    for (const d of t.meta.depends) if (!ids.has(d)) problems.push(`${t.meta.id}: depends on unknown task ${d}`);
    if (t.meta.status === 'done') {
      for (const d of t.meta.depends) {
        const dep = tasks.find((x) => x.meta.id === d);
        if (dep && dep.meta.status !== 'done') problems.push(`${t.meta.id}: done, but dependency ${d} is ${dep.meta.status}`);
      }
    }
  }
  // cycle detection
  const state = new Map();
  const walk = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') return problems.push(`dependency cycle: ${[...trail, id].join(' → ')}`);
    state.set(id, 'open');
    for (const d of tasks.find((t) => t.meta.id === id)?.meta.depends ?? []) {
      if (ids.has(d)) walk(d, [...trail, id]);
    }
    state.set(id, 'done');
  };
  for (const t of tasks) walk(t.meta.id, []);

  if (!problems.length) return console.log(`${C.g}ok${C.x} ${tasks.length} tasks, no integrity problems`);
  for (const p of problems) console.log(`${C.r}✗${C.x} ${p}`);
  process.exit(1);
}

// ---------------------------------------------------------------- entry

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

if (cmd === 'init') {
  await init();
} else {
  const tasks = loadAll();
  if (!tasks.length && cmd !== 'init') fail('no task files — run `node scripts/tasks.mjs init` first');
  switch (cmd) {
    case 'board': case undefined: board(tasks); break;
    case 'next': next(tasks, flag('stream')); break;
    case 'show': show(tasks, positional[0]); break;
    case 'claim': claim(tasks, positional[0], flag('as')); break;
    case 'done': done(tasks, positional[0], flag('note')); break;
    case 'block': block(tasks, positional[0], flag('reason')); break;
    case 'release': release(tasks, positional[0]); break;
    case 'check': check(tasks); break;
    default: fail(`unknown command "${cmd}". Try: init, board, next, show, claim, done, block, release, check`);
  }
}
