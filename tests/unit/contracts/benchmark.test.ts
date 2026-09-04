import { describe, expect, it } from 'vitest';
import { BENCHMARK_MIN_SITES, BenchmarkSchema, benchmarkOf } from '@gc/contracts';

// The benchmark (L-04) is a distribution of open-finding counts, and the product only
// ever speaks of a share when the sample is large enough to mean something.

describe('benchmark', () => {
  it('accepts what the canary writes and nothing that names a site', () => {
    expect(BenchmarkSchema.parse({ date: '2026-09-03', n: 2, counts: [0, 4] })).toEqual({
      date: '2026-09-03',
      n: 2,
      counts: [0, 4],
    });
    expect(BenchmarkSchema.parse({ date: null, n: 0, counts: [] }).n).toBe(0);
    expect(() => BenchmarkSchema.parse({ date: '3 Sep', n: 1, counts: [1] })).toThrow();
    expect(() => BenchmarkSchema.parse({ date: null, n: 1, counts: [-1] })).toThrow();
    expect(
      BenchmarkSchema.safeParse({ date: null, n: 1, counts: [{ host: 'a.test', n: 1 }] }).success,
    ).toBe(false);
  });

  it('gives the share of watched sites doing worse, in whole percent', () => {
    const counts = Array.from({ length: 40 }, (_, i) => i);
    const b = { date: '2026-09-03', n: 40, counts };
    expect(benchmarkOf(0, b)).toEqual({ n: 40, date: '2026-09-03', share: 98, enough: true });
    expect(benchmarkOf(19, b).share).toBe(50);
    expect(benchmarkOf(39, b).share).toBe(0);
    expect(benchmarkOf(100, b).share).toBe(0);
  });

  it('withholds the share below the minimum sample', () => {
    const small = {
      date: '2026-09-03',
      n: BENCHMARK_MIN_SITES - 1,
      counts: Array(BENCHMARK_MIN_SITES - 1).fill(9),
    };
    expect(benchmarkOf(1, small).enough).toBe(false);
    expect(
      benchmarkOf(1, { ...small, n: BENCHMARK_MIN_SITES, counts: [...small.counts, 9] }).enough,
    ).toBe(true);
    expect(benchmarkOf(1, { date: null, n: 0, counts: [] })).toEqual({
      n: 0,
      date: null,
      share: 0,
      enough: false,
    });
  });
});
