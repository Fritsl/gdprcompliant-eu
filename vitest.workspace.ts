import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineWorkspace } from 'vitest/config';
import { SUITES } from './tests/suites.js';

// One project per suite, from the tagged manifest in tests/suites.ts. Each is runnable
// alone (pnpm test:<name>) and all together (pnpm test); the delivery gate (O-05) picks
// the required ones from the same list.
//
// The unit project physically blocks the network and the database (tests/setup/
// no-network.ts): a unit test that reaches out fails, rather than passing slowly.

// The integration suites need the test database. Its connection string is explicit: it
// comes from .env under its own name, and DATABASE_URL is never handed to a test.
function readTestEnv(): Record<string, string> {
  if (!existsSync('.env')) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*(GC_TEST_DATABASE_URL)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export default defineWorkspace(
  SUITES.map((suite) => ({
    extends: './vitest.config.ts',
    test: {
      name: suite.name,
      // The web app's server modules, for the suites that exercise its routes directly:
      // '@/' is the app root, and 'server-only' is a stub outside a React server bundle.
      alias:
        suite.name === 'unit'
          ? []
          : [
              { find: '@', replacement: fileURLToPath(new URL('./apps/web', import.meta.url)) },
              {
                find: 'server-only',
                replacement: fileURLToPath(
                  new URL('./tests/setup/server-only.ts', import.meta.url),
                ),
              },
            ],
      include: [`tests/${suite.name}/**/*.test.ts`],
      testTimeout: suite.testTimeoutMs,
      hookTimeout: suite.testTimeoutMs,
      passWithNoTests: true,
      // The e2e suites each register workers on pg-boss, whose schema is shared across the
      // per-file test schemas; run in parallel they steal each other's jobs. One fork, in turn.
      ...(suite.name === 'e2e' ? { poolOptions: { forks: { singleFork: true } } } : {}),
      ...(suite.name === 'unit'
        ? { setupFiles: ['./tests/setup/no-network.ts'] }
        : { env: readTestEnv() }),
    },
  })),
);
