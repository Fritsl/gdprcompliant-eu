// pnpm run gate (O-05, T-12)
//
// One command, one verdict. The gate runs the invariants the build enforces, every suite
// the manifest marks required, and the canary comparison, in that order; any red is a
// hard stop, named with the task it belongs to and that task's owner. It writes a dated
// report to artifacts/gate/, with the manual smoke checklist appended for the pair of
// eyes the automation cannot replace, and seals the report with a hash and the name of
// whoever ran it.
//
//   pnpm run gate                 run everything, exit 1 on any red
//   pnpm run gate -- --dry-run    print the plan and the environment, run nothing, exit 0
//   pnpm run gate -- --json       the report as JSON on stdout as well
//   pnpm run gate -- --only unit  run one step (by id) and nothing else

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITES, type Suite } from '../tests/suites.js';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CHECKLIST_FILE = join(ROOT, 'docs', 'smoke-checklist.md');
export const REPORT_DIR = join(ROOT, 'artifacts', 'gate');

export type StepKind = 'invariant' | 'suite' | 'canary';

export interface Step {
  readonly id: string;
  readonly title: string;
  readonly kind: StepKind;
  readonly command: readonly string[];
  // The task this step proves; its owner is who a red belongs to.
  readonly task: string;
  readonly budgetSeconds: number;
  readonly needs: readonly Suite['needs'][number][];
  // Informs but never blocks (a nightly suite).
  readonly advisory?: boolean;
}

// Every invariant the build enforces (TESTING.md, "Invariants enforced at build time"),
// each with the task that made it a rule.
const INVARIANTS: readonly Step[] = [
  inv('typecheck', 'Types', ['pnpm', '-r', 'typecheck'], 'F-01', 300),
  inv('lint', 'Lint', ['pnpm', 'lint'], 'F-01', 120),
  inv('format', 'Formatting', ['pnpm', 'format:check'], 'F-01', 60),
  inv('rls', 'Row-level security on every table', ['pnpm', 'check:rls'], 'F-05', 60),
  inv('retention', 'Every table declares its lifetime', ['pnpm', 'check:retention'], 'O-02', 60),
  inv('finding-completeness', 'Every finding has a remedy in every jurisdiction', ['pnpm', 'check:finding-completeness'], 'R-02', 60),
  inv('citations', 'Every citation resolves, every quote is as published', ['pnpm', 'check:citations'], 'T-03', 120),
  inv('guide-snippets', 'Every guide snippet is proven', ['pnpm', 'check:guide-snippets'], 'R-03', 60),
  inv('claims', 'No certification or verdict vocabulary', ['pnpm', 'check:claims'], 'O-03', 60),
  inv('registries', 'Registries are current', ['pnpm', 'check:registries'], 'D-04', 60),
  inv('rule-citations', 'Every rule cites resolving law', ['pnpm', 'check:rule-citations'], 'A-03', 60),
  inv('i18n', 'Every string speaks every required locale', ['pnpm', 'check:i18n-coverage'], 'I-01', 60),
  inv('schema-doc', 'The schema document is current', ['node', 'scripts/schema-doc.mjs', '--check'], 'F-03', 60),
  inv('findings-doc', 'The findings document is current', ['pnpm', 'findings:doc', '--check'], 'I-02', 60),
  inv('remedy-lock', 'The remedy lock matches the catalogue', ['node', 'scripts/remedy-lock.mjs', '--check'], 'R-01', 60),
  inv('evals-history', 'The eval history is current', ['node', 'scripts/evals-history.mjs', '--check'], 'T-05', 60),
];

function inv(id: string, title: string, command: readonly string[], task: string, budgetSeconds: number): Step {
  return { id, title, kind: 'invariant', command, task, budgetSeconds, needs: [] };
}

// The suite that proves each task, so a red names the right owner.
const SUITE_TASKS: Record<string, string> = {
  unit: 'T-04',
  integration: 'F-08',
  e2e: 'T-09',
  evals: 'T-05',
  adversarial: 'T-06',
  perf: 'T-11',
};

export function steps(): Step[] {
  const suites: Step[] = SUITES.map((s) => ({
    id: s.name,
    title: `Suite: ${s.name}`,
    kind: 'suite',
    command: ['pnpm', `test:${s.name}`],
    task: SUITE_TASKS[s.name] ?? 'F-08',
    budgetSeconds: s.budgetSeconds,
    needs: s.needs,
    ...(s.gate === 'nightly' ? { advisory: true } : {}),
  }));
  const canary: Step = {
    id: 'canary',
    title: 'Canary: the scanner, not the internet, is what changed',
    kind: 'canary',
    command: ['pnpm', 'canary:check'],
    task: 'T-10',
    budgetSeconds: 120,
    needs: [],
  };
  return [...INVARIANTS, ...suites, canary];
}

// ---- owners, from the task files ------------------------------------------------------------

export interface TaskOwner {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly status: string;
}

export function taskOwner(id: string, root = ROOT): TaskOwner {
  const file = join(root, 'tasks', `${id}.md`);
  if (!existsSync(file)) return { id, title: id, owner: 'unassigned', status: 'unknown' };
  const text = readFileSync(file, 'utf8');
  const meta: Record<string, string> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  for (const line of (m?.[1] ?? '').split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  return {
    id,
    title: meta['title'] ?? id,
    owner: meta['owner'] ?? 'unassigned',
    status: meta['status'] ?? 'unknown',
  };
}

// ---- the environment: what each need resolves to, before anything runs ---------------------

export interface Environment {
  readonly database: boolean;
  readonly cassettes: boolean;
  readonly browser: boolean;
  readonly model: boolean;
  readonly commit: string;
  readonly node: string;
}

export function environment(env: NodeJS.ProcessEnv = process.env, root = ROOT): Environment {
  const cassettes = join(root, 'fixtures', 'cassettes');
  const browsers =
    env['PLAYWRIGHT_BROWSERS_PATH'] ??
    (process.platform === 'win32'
      ? join(env['LOCALAPPDATA'] ?? '', 'ms-playwright')
      : process.platform === 'darwin'
        ? join(env['HOME'] ?? '', 'Library', 'Caches', 'ms-playwright')
        : join(env['HOME'] ?? '', '.cache', 'ms-playwright'));
  return {
    database: Boolean(env['GC_TEST_DATABASE_URL'] ?? env['DATABASE_URL']),
    cassettes: existsSync(cassettes) && readdirSync(cassettes).length > 0,
    browser: existsSync(browsers) && readdirSync(browsers).some((d) => d.startsWith('chromium')),
    model: Boolean(env['MODEL_BASE_URL'] && env['MODEL_CHAT']),
    commit: gitCommit(root),
    node: process.version,
  };
}

function gitCommit(root: string): string {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

export const unmet = (step: Step, env: Environment): string[] =>
  step.needs.filter((n) => !env[n]);

// ---- the checklist: under fifteen yes-or-no observations ----------------------------------

export interface ChecklistItem {
  readonly n: number;
  readonly text: string;
}

export function checklist(file = CHECKLIST_FILE): ChecklistItem[] {
  const text = readFileSync(file, 'utf8');
  const items: ChecklistItem[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\.\s+(.*\S)\s*$/.exec(line);
    if (m) items.push({ n: Number(m[1]), text: m[2]! });
  }
  return items;
}

// ---- running ----------------------------------------------------------------------------------

export type StepStatus = 'green' | 'red' | 'skipped' | 'planned' | 'advisory-red';

export interface StepResult {
  readonly step: Step;
  readonly status: StepStatus;
  readonly durationMs: number;
  readonly detail?: string;
  readonly owner: TaskOwner;
}

export interface GateReport {
  readonly at: string;
  readonly commit: string;
  readonly dryRun: boolean;
  readonly verdict: 'pass' | 'fail' | 'planned';
  readonly environment: Environment;
  readonly results: readonly StepResult[];
  readonly checklist: readonly ChecklistItem[];
  readonly signer: string;
  readonly signature: string;
}

export interface RunOptions {
  readonly dryRun?: boolean;
  readonly only?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly root?: string;
  readonly now?: () => Date;
  readonly signer?: string;
  // For tests: how a command is run. Default spawns it.
  readonly exec?: (step: Step) => { status: number | null; output: string };
}

function spawnStep(step: Step, root: string, env: NodeJS.ProcessEnv): { status: number | null; output: string } {
  const [cmd, ...args] = step.command;
  const r = spawnSync(cmd!, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: step.budgetSeconds * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT')
    return { status: 124, output: `${output}\nbudget of ${step.budgetSeconds}s exceeded` };
  return { status: r.status, output };
}

const tail = (s: string, lines = 12): string =>
  s
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-lines)
    .join('\n');

export function runGate(options: RunOptions = {}): GateReport {
  const root = options.root ?? ROOT;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const started = now();
  const environmentNow = environment(env, root);
  const all = steps().filter((s) => !options.only || s.id === options.only);
  const results: StepResult[] = [];
  for (const step of all) {
    const owner = taskOwner(step.task, root);
    const missing = unmet(step, environmentNow);
    if (options.dryRun) {
      results.push({
        step,
        status: missing.length > 0 ? 'skipped' : 'planned',
        durationMs: 0,
        owner,
        ...(missing.length > 0 ? { detail: `needs ${missing.join(', ')}` } : {}),
      });
      continue;
    }
    if (missing.length > 0) {
      // A required suite whose tools are absent is a red, not a pass: the gate cannot
      // vouch for what it did not run.
      results.push({
        step,
        status: step.advisory ? 'skipped' : 'red',
        durationMs: 0,
        owner,
        detail: `not run: needs ${missing.join(', ')}`,
      });
      continue;
    }
    const t0 = Date.now();
    const r = (options.exec ?? ((s) => spawnStep(s, root, env)))(step);
    const durationMs = Date.now() - t0;
    const ok = r.status === 0 && durationMs <= step.budgetSeconds * 1000;
    results.push({
      step,
      status: ok ? 'green' : step.advisory ? 'advisory-red' : 'red',
      durationMs,
      owner,
      ...(ok
        ? {}
        : {
            detail:
              r.status === 0
                ? `over budget: ${Math.round(durationMs / 1000)}s of ${step.budgetSeconds}s`
                : tail(r.output),
          }),
    });
    if (!ok && !step.advisory) break; // a red is a stop
  }
  const verdict: GateReport['verdict'] = options.dryRun
    ? 'planned'
    : results.some((r) => r.status === 'red') || results.length < all.length
      ? 'fail'
      : 'pass';
  const signer = options.signer ?? env['GATE_SIGNER'] ?? gitUser(root);
  const body = {
    at: started.toISOString(),
    commit: environmentNow.commit,
    dryRun: Boolean(options.dryRun),
    verdict,
    environment: environmentNow,
    results,
    checklist: checklist(join(root, 'docs', 'smoke-checklist.md')),
    signer,
  };
  return { ...body, signature: sign(body) };
}

function gitUser(root: string): string {
  const r = spawnSync('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : 'unknown';
}

// The seal: a hash over the report as written, so a report edited after the fact no
// longer matches its own signature. Verifiable with verifySignature().
export const sign = (body: Omit<GateReport, 'signature'>): string =>
  createHash('sha256').update(JSON.stringify(body)).digest('hex');

export function verifySignature(report: GateReport): boolean {
  const { signature, ...body } = report;
  return sign(body) === signature;
}

// ---- the report, as a person reads it -------------------------------------------------------

const MARK: Record<StepStatus, string> = {
  green: 'PASS',
  red: 'FAIL',
  skipped: 'SKIP',
  planned: 'PLAN',
  'advisory-red': 'WARN',
};

export function formatReport(r: GateReport): string {
  const lines: string[] = [];
  lines.push(`# Delivery gate · ${r.verdict.toUpperCase()}`);
  lines.push('');
  lines.push(`- Date: ${r.at}`);
  lines.push(`- Commit: ${r.commit}`);
  lines.push(`- Run by: ${r.signer}`);
  lines.push(`- Mode: ${r.dryRun ? 'dry run (nothing was executed)' : 'full'}`);
  lines.push(
    `- Environment: database ${r.environment.database ? 'yes' : 'no'} · cassettes ${r.environment.cassettes ? 'yes' : 'no'} · browser ${r.environment.browser ? 'yes' : 'no'} · model ${r.environment.model ? 'yes' : 'no'} · node ${r.environment.node}`,
  );
  lines.push('');
  lines.push('| Step | Result | Time | Task | Owner |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const x of r.results) {
    const time = x.durationMs > 0 ? `${Math.round(x.durationMs / 1000)}s / ${x.step.budgetSeconds}s` : `– / ${x.step.budgetSeconds}s`;
    lines.push(`| ${x.step.title} | ${MARK[x.status]} | ${time} | ${x.step.task} | ${x.owner.owner} |`);
  }
  const reds = r.results.filter((x) => x.status === 'red' || x.status === 'advisory-red');
  if (reds.length > 0) {
    lines.push('');
    lines.push('## Red');
    for (const x of reds) {
      lines.push('');
      lines.push(`### ${x.step.title} · ${x.step.task} (${x.owner.title}) · owner ${x.owner.owner}`);
      lines.push('');
      lines.push('```');
      lines.push(x.detail ?? '');
      lines.push('```');
    }
  }
  if (r.verdict === 'fail') {
    lines.push('');
    lines.push('Nothing is handed over on a red gate.');
  }
  lines.push('');
  lines.push('## Manual smoke checklist');
  lines.push('');
  lines.push('Each line is a yes-or-no observation. Tick what you saw; leave what you did not.');
  lines.push('');
  for (const c of r.checklist) lines.push(`- [ ] ${c.n}. ${c.text}`);
  lines.push('');
  lines.push(`Signature: sha256 ${r.signature}`);
  lines.push('');
  return lines.join('\n');
}

export function writeReport(r: GateReport, dir = REPORT_DIR): { md: string; json: string } {
  mkdirSync(dir, { recursive: true });
  const stamp = r.at.replace(/[:.]/g, '-');
  const base = join(dir, `${stamp}-${r.commit}${r.dryRun ? '-dry-run' : ''}`);
  writeFileSync(`${base}.json`, JSON.stringify(r, null, 2) + '\n');
  writeFileSync(`${base}.md`, formatReport(r));
  return { md: `${base}.md`, json: `${base}.json` };
}

// ---- main -------------------------------------------------------------------------------------

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const json = argv.includes('--json');
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt >= 0 ? argv[onlyAt + 1] : undefined;
  const report = runGate({ dryRun, ...(only ? { only } : {}) });
  const files = writeReport(report);
  console.log(formatReport(report));
  if (json) console.log(JSON.stringify(report, null, 2));
  console.log(`report: ${files.md}`);
  process.exit(report.verdict === 'fail' ? 1 : 0);
}
