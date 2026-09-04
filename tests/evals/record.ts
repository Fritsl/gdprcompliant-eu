import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, type EvalSetId } from './sets.js';

// Where an eval run leaves its numbers (T-05): one line per set per run, appended to
// artifacts/evals/results.jsonl, with the commit, the day, whether a model was measured
// or only the pipeline against the labels, and the rate. CI uploads the file and the
// history script folds it into docs/evals.md, so a prompt change that moves a number is
// visible in a table rather than discovered by a customer.

export const RESULTS_FILE = join(ROOT, 'artifacts', 'evals', 'results.jsonl');

export interface EvalResult {
  readonly set: EvalSetId;
  // 'model' when a configured model was measured; 'pipeline' when the labels drove a stub.
  readonly mode: 'model' | 'pipeline';
  readonly agreed: number;
  readonly total: number;
  readonly threshold: number;
  readonly misses?: readonly string[];
}

const commit = (): string => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

export function recordEvalResult(result: EvalResult): void {
  mkdirSync(join(ROOT, 'artifacts', 'evals'), { recursive: true });
  const row = {
    at: new Date().toISOString(),
    commit: commit(),
    model: process.env['MODEL_CHAT'] ?? null,
    ...result,
    rate: result.total === 0 ? 0 : result.agreed / result.total,
    passed: result.total === 0 ? false : result.agreed / result.total >= result.threshold,
  };
  appendFileSync(RESULTS_FILE, JSON.stringify(row) + '\n');
  console.log(
    `eval ${result.set} (${result.mode}): ${result.agreed}/${result.total} = ${(row.rate * 100).toFixed(1)}% against ${(result.threshold * 100).toFixed(0)}%${result.misses?.length ? `\n  ${result.misses.join('\n  ')}` : ''}`,
  );
}
