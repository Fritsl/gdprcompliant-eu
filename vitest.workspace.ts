import { defineWorkspace } from 'vitest/config';

// One project per suite so the delivery gate (O-05) can require specific ones, and so
// unit stays fast: no database, no network, under 30 seconds.
const suite = (name: string) => ({
  extends: './vitest.config.ts',
  test: { name, include: [`tests/${name}/**/*.test.ts`] },
});

export default defineWorkspace([
  suite('unit'),
  suite('integration'),
  suite('e2e'),
  suite('evals'),
  suite('adversarial'),
  suite('perf'),
]);
