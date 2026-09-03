import { defineWorkspace } from 'vitest/config';
import { SUITES } from './tests/suites.js';

// One project per suite, from the tagged manifest in tests/suites.ts. Each is runnable
// alone (pnpm test:<name>) and all together (pnpm test); the delivery gate (O-05) picks
// the required ones from the same list.
//
// The unit project physically blocks the network and the database (tests/setup/
// no-network.ts): a unit test that reaches out fails, rather than passing slowly.

export default defineWorkspace(
  SUITES.map((suite) => ({
    extends: './vitest.config.ts',
    test: {
      name: suite.name,
      include: [`tests/${suite.name}/**/*.test.ts`],
      testTimeout: suite.testTimeoutMs,
      hookTimeout: suite.testTimeoutMs,
      passWithNoTests: true,
      ...(suite.name === 'unit' ? { setupFiles: ['./tests/setup/no-network.ts'] } : {}),
    },
  })),
);
