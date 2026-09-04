import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHECKLIST_FILE,
  ROOT,
  checklist,
  environment,
  formatReport,
  runGate,
  steps,
  taskOwner,
  verifySignature,
  writeReport,
  type Step,
} from '../../scripts/gate.js';
import { SUITES } from '../suites.js';

// The delivery gate (T-12): one command aggregates every required suite, every
// invariant and the canary into one verdict; any red stops it and names a task and its
// owner; the manual checklist is short and made of yes-or-no observations; the report
// it writes is dated and sealed.

describe('the gate plan', () => {
  it('covers every required suite from the manifest, every invariant, and the canary', () => {
    const plan = steps();
    for (const s of SUITES) {
      const step = plan.find((p) => p.id === s.name);
      expect(step, s.name).toBeDefined();
      expect(step!.command).toEqual(['pnpm', `test:${s.name}`]);
      expect(step!.budgetSeconds).toBe(s.budgetSeconds);
      expect(Boolean(step!.advisory)).toBe(s.gate === 'nightly');
    }
    expect(plan.some((p) => p.kind === 'canary')).toBe(true);
    expect(plan.filter((p) => p.kind === 'invariant').length).toBeGreaterThanOrEqual(12);
    // Invariants first, suites after, the canary last: a wrong file stops the gate
    // before a browser is opened.
    const kinds = plan.map((p) => p.kind);
    expect(kinds.indexOf('suite')).toBeGreaterThan(kinds.lastIndexOf('invariant'));
    expect(kinds[kinds.length - 1]).toBe('canary');
  });

  it('every step names a task that exists, with an owner', () => {
    for (const s of steps()) {
      expect(existsSync(join(ROOT, 'tasks', `${s.task}.md`)), `${s.id} → ${s.task}`).toBe(true);
      const owner = taskOwner(s.task);
      expect(owner.owner.length).toBeGreaterThan(0);
      expect(owner.title).not.toBe(s.task);
    }
  });
});

describe('the manual checklist', () => {
  it('is under fifteen items, numbered, each a yes-or-no observation', () => {
    const items = checklist(CHECKLIST_FILE);
    expect(items.length).toBeGreaterThanOrEqual(8);
    expect(items.length).toBeLessThan(15);
    items.forEach((c, i) => {
      expect(c.n).toBe(i + 1);
      expect(c.text.endsWith('?'), c.text).toBe(true);
      // An observation, not a judgement: no "good", "nice", "reasonable", "acceptable".
      expect(c.text).not.toMatch(/\b(good|nice|reasonable|acceptable|well enough|looks ok)\b/i);
    });
  });
});

describe('a run', () => {
  const green = (step: Step) => ({ status: 0, output: `${step.id} ok` });

  it('a dry run plans every step, runs nothing, and says what each needs', () => {
    let executed = 0;
    const r = runGate({
      dryRun: true,
      exec: () => {
        executed += 1;
        return { status: 0, output: '' };
      },
      env: {},
      signer: 'test',
    });
    expect(executed).toBe(0);
    expect(r.verdict).toBe('planned');
    expect(r.results.length).toBe(steps().length);
    const e2e = r.results.find((x) => x.step.id === 'e2e')!;
    expect(e2e.status).toBe('skipped');
    expect(e2e.detail).toContain('database');
    expect(r.results.find((x) => x.step.id === 'unit')!.status).toBe('planned');
    expect(verifySignature(r)).toBe(true);
    expect(formatReport(r)).toContain('dry run');
  });

  it('all green is a pass, with the checklist appended and the seal intact', () => {
    const env = {
      GC_TEST_DATABASE_URL: 'postgres://x',
      MODEL_BASE_URL: 'https://m',
      MODEL_CHAT: 'c',
    };
    const r = runGate({ exec: green, env: { ...env }, signer: 'test' });
    // The browser and the cassettes come from the machine; a step whose tools are
    // missing is a red, so the verdict here says what this machine can vouch for.
    const machine = environment(env);
    const runnable = steps().filter((s) => s.needs.every((n) => machine[n]));
    if (runnable.length === steps().length) {
      expect(r.verdict).toBe('pass');
      expect(r.results.every((x) => x.status === 'green')).toBe(true);
    } else {
      expect(r.verdict).toBe('fail');
      expect(r.results.filter((x) => x.status === 'green').length).toBeGreaterThan(0);
    }
    expect(r.checklist.length).toBe(checklist(CHECKLIST_FILE).length);
    expect(verifySignature(r)).toBe(true);
    expect(verifySignature({ ...r, verdict: 'pass', signer: 'someone else' })).toBe(false);
    const md = formatReport(r);
    expect(md).toContain('Manual smoke checklist');
    expect(md).toContain(`Signature: sha256 ${r.signature}`);
  });
  it('a red stops the gate and names the task and its owner', () => {
    const env = {
      GC_TEST_DATABASE_URL: 'postgres://x',
      MODEL_BASE_URL: 'https://m',
      MODEL_CHAT: 'c',
    };
    const r = runGate({
      exec: (step) =>
        step.id === 'claims'
          ? { status: 1, output: 'claims: 1 problem(s)\n  ✗ certified' }
          : { status: 0, output: '' },
      env,
      signer: 'test',
    });
    expect(r.verdict).toBe('fail');
    const red = r.results.find((x) => x.status === 'red')!;
    expect(red.step.id).toBe('claims');
    expect(red.step.task).toBe('O-03');
    expect(red.owner.owner).not.toBe('unassigned');
    expect(red.detail).toContain('certified');
    // Nothing after the red ran.
    expect(r.results[r.results.length - 1]!.step.id).toBe('claims');
    const md = formatReport(r);
    expect(md).toContain('FAIL');
    expect(md).toContain('O-03');
    expect(md).toContain('Nothing is handed over on a red gate.');
  });

  it('a required suite whose tools are absent is a red, not a pass', () => {
    const r = runGate({ exec: green, env: {}, signer: 'test' });
    expect(r.verdict).toBe('fail');
    const red = r.results.find((x) => x.status === 'red')!;
    expect(red.detail).toMatch(/not run: needs/);
  });

  it('--only runs one step and nothing else', () => {
    const ran: string[] = [];
    const r = runGate({
      only: 'format',
      exec: (step) => {
        ran.push(step.id);
        return { status: 0, output: '' };
      },
      env: {},
      signer: 'test',
    });
    expect(ran).toEqual(['format']);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]!.status).toBe('green');
    expect(r.verdict).toBe('pass');
  });
  it('writes a dated, sealed report as markdown and JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    try {
      const r = runGate({
        dryRun: true,
        env: {},
        signer: 'test',
        now: () => new Date('2026-09-04T20:00:00Z'),
      });
      const files = writeReport(r, dir);
      expect(existsSync(files.md)).toBe(true);
      expect(existsSync(files.json)).toBe(true);
      expect(files.md).toContain('2026-09-04T20-00-00');
      expect(files.md).toContain('dry-run');
      const back = JSON.parse(readFileSync(files.json, 'utf8'));
      expect(verifySignature(back)).toBe(true);
      expect(readFileSync(files.md, 'utf8')).toContain('# Delivery gate · PLANNED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
