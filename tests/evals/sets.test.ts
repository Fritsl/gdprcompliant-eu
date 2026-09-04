import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { declaredEndpoints, loadConfig } from '@gc/config';
import { EVAL_SETS, MIN_SCENARIOS, ROOT } from './sets.js';

// The eval sets themselves (T-05): every set has at least twenty labelled scenarios,
// every scenario carries the reasoning behind its label, every threshold is declared
// here and matches the table in TESTING.md, the eval that enforces it exists, and when
// a model is configured it is the self-hosted one: a declared endpoint of purpose
// model, inside the EEA, and never a hosted provider's API.

const HOSTED_PROVIDERS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.cohere.ai',
  'api.mistral.ai',
  'openrouter.ai',
];

describe('the eval sets', () => {
  it('are the five judgement sites, each with at least twenty labelled scenarios and their reasoning', async () => {
    expect(EVAL_SETS.map((s) => s.id)).toEqual([
      'policy-clauses',
      'dpa-analysis',
      'planner',
      'verifier',
      'advisor',
    ]);
    for (const set of EVAL_SETS) {
      const scenarios = await set.scenarios();
      expect(scenarios.length, set.id).toBeGreaterThanOrEqual(MIN_SCENARIOS);
      expect(new Set(scenarios.map((s) => s.label)).size, `${set.id}: labels unique`).toBe(
        scenarios.length,
      );
      for (const s of scenarios) {
        expect(
          s.reasoning.trim().length,
          `${set.id}: ${s.label} has no reasoning`,
        ).toBeGreaterThanOrEqual(40);
      }
      expect(set.threshold).toBeGreaterThanOrEqual(0.9);
      expect(set.threshold).toBeLessThanOrEqual(1);
      expect(readFileSync(join(ROOT, set.test), 'utf8')).toContain("from './sets.js'");
    }
  });

  it('are documented in TESTING.md with the same counts and thresholds CI enforces', async () => {
    const testing = readFileSync(join(ROOT, 'TESTING.md'), 'utf8');
    for (const set of EVAL_SETS) {
      const count = (await set.scenarios()).length;
      const row = testing
        .split('\n')
        .find((l) => l.startsWith('|') && l.includes(`(\`${set.task}\`)`));
      expect(row, `${set.id} has a row in TESTING.md`).toBeDefined();
      expect(row).toContain(`${count} `);
      expect(row).toContain(`≥ ${Math.round(set.threshold * 100)}% ${set.measure}`);
    }
  });

  it('measures the self-hosted model when one is configured, and never a hosted API', () => {
    const base = process.env['MODEL_BASE_URL'];
    const host = base ? new URL(base).hostname : undefined;
    for (const h of HOSTED_PROVIDERS) expect(host).not.toBe(h);
    if (!host) {
      console.log(
        'eval sets: no MODEL_BASE_URL in the environment; the self-hosted rule is not exercised',
      );
      return;
    }
    const endpoint = declaredEndpoints().find((e) => e.host === host);
    expect(endpoint, `${host} is declared`).toBeDefined();
    expect(endpoint?.purpose).toBe('model');
    expect(endpoint?.jurisdiction).toMatch(
      /^(EU|AT|BE|BG|HR|CY|CZ|DK|EE|FI|FR|DE|GR|HU|IE|IT|LV|LT|LU|MT|NL|PL|PT|RO|SK|SI|ES|SE|IS|LI|NO)$/,
    );
    const config = loadConfig();
    expect(new URL(config.model.baseUrl).hostname).toBe(host);
  });
});
