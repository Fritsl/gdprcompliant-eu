import { z } from 'zod';

// The benchmark (L-04): what the nightly canary run leaves for the product. The date,
// how many sites were scanned, and how many open findings each had. No host and no
// order: a distribution, nothing that identifies a watched site.
export const BenchmarkSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  n: z.number().int().min(0),
  counts: z.array(z.number().int().min(0)),
});
export type Benchmark = z.infer<typeof BenchmarkSchema>;

// Below this the number is withheld: a percentile of a dozen sites is a coin toss.
export const BENCHMARK_MIN_SITES = 30;

export interface BenchmarkView {
  readonly n: number;
  readonly date: string | null;
  // The share of watched sites with more open findings than this case, in whole percent.
  readonly share: number;
  readonly enough: boolean;
}

// Honest about the sample: the share is given only from BENCHMARK_MIN_SITES sites up.
export function benchmarkOf(open: number, b: Benchmark): BenchmarkView {
  const worse = b.counts.filter((c) => c > open).length;
  const share = b.n === 0 ? 0 : Math.round((worse / b.n) * 100);
  return { n: b.n, date: b.date, share, enough: b.n >= BENCHMARK_MIN_SITES };
}
