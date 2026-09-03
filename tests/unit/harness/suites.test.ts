import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../../../vitest.config.js';
import workspace from '../../../vitest.workspace.js';
import {
  ARTIFACTS,
  COVERAGE_CRITICAL_PACKAGES,
  COVERAGE_FLOOR,
  COVERAGE_FLOOR_CRITICAL,
  SUITES,
} from '../../suites.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type Project = { extends?: string; test?: Record<string, unknown> };
type Thresholds = Record<string, number | Record<string, number>>;

describe('the suites are tagged, and the harness follows the tags (F-08)', () => {
  it('names are unique and each suite has a directory', () => {
    const names = SUITES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(existsSync(join(ROOT, 'tests', name)), `tests/${name} is missing`).toBe(true);
    }
  });

  it('the five suites the strategy names are all required by the gate', () => {
    const required = SUITES.filter((s) => s.gate === 'required').map((s) => s.name);
    expect(required).toEqual(
      expect.arrayContaining(['unit', 'integration', 'e2e', 'evals', 'adversarial']),
    );
  });

  it('unit needs nothing and runs inside 30 seconds', () => {
    const unit = SUITES.find((s) => s.name === 'unit');
    expect(unit?.needs).toEqual([]);
    expect(unit?.budgetSeconds).toBeLessThanOrEqual(30);
    expect(unit?.testTimeoutMs).toBeLessThanOrEqual(10_000);
  });

  it('the workspace has exactly one project per suite, unit with the no-network setup', () => {
    const projects = workspace as unknown as Project[];
    expect(projects.map((p) => p.test?.['name'])).toEqual(SUITES.map((s) => s.name));
    for (const p of projects) {
      const suite = SUITES.find((s) => s.name === p.test?.['name']);
      expect(p.test?.['include']).toEqual([`tests/${suite?.name}/**/*.test.ts`]);
      expect(p.test?.['testTimeout']).toBe(suite?.testTimeoutMs);
    }
    const unit = projects.find((p) => p.test?.['name'] === 'unit');
    expect(unit?.test?.['setupFiles']).toEqual(['./tests/setup/no-network.ts']);
    const others = projects.filter((p) => p.test?.['name'] !== 'unit');
    for (const p of others) expect(p.test?.['setupFiles']).toBeUndefined();
  });

  it('every package script runs the project it is named after', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const suite of SUITES) {
      expect(pkg.scripts[`test:${suite.name}`]).toBe(`vitest run --project ${suite.name}`);
    }
  });

  it('a junit report and an HTML report land in artifacts/', () => {
    const reporters = (config.test?.reporters ?? []) as unknown[];
    const named = reporters.map((r) => (Array.isArray(r) ? r : [r]));
    expect(named).toEqual(
      expect.arrayContaining([
        ['junit', { outputFile: ARTIFACTS.junit }],
        ['html', { outputFile: ARTIFACTS.html }],
      ]),
    );
    expect(ARTIFACTS.junit.startsWith('artifacts/')).toBe(true);
    expect(ARTIFACTS.html.startsWith('artifacts/')).toBe(true);
    const coverage = config.test?.coverage as { reportsDirectory?: string; reporter?: string[] };
    expect(coverage.reportsDirectory).toBe(ARTIFACTS.coverage);
    expect(coverage.reporter).toEqual(expect.arrayContaining(['html', 'lcov']));
  });

  it('coverage floors: 85 on findings, rules and remedies, 70 elsewhere', () => {
    const thresholds = (config.test?.coverage as { thresholds: Thresholds }).thresholds;
    expect(COVERAGE_FLOOR).toBe(70);
    expect(COVERAGE_FLOOR_CRITICAL).toBe(85);
    expect([...COVERAGE_CRITICAL_PACKAGES].sort()).toEqual(['findings', 'remedies', 'rules']);
    for (const metric of ['lines', 'functions', 'branches', 'statements']) {
      expect(thresholds[metric]).toBe(70);
      for (const pkg of COVERAGE_CRITICAL_PACKAGES) {
        const perPackage = thresholds[`packages/${pkg}/src/**/*.ts`] as Record<string, number>;
        expect(perPackage[metric], `${pkg} ${metric}`).toBe(85);
      }
    }
  });
});
