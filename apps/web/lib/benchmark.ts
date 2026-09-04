import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchmarkSchema, type Benchmark } from '@gc/contracts';

// The benchmark file the nightly canary commits (L-04). CANARY_BENCHMARK_FILE points
// elsewhere in tests; a missing file is an empty benchmark, never an error on a case page.
export const BENCHMARK_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/canary/benchmark.json',
);

export function loadBenchmark(
  file: string | undefined = process.env['CANARY_BENCHMARK_FILE'],
): Benchmark {
  const path = file ?? BENCHMARK_FILE;
  if (!existsSync(path)) return { date: null, n: 0, counts: [] };
  return BenchmarkSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
