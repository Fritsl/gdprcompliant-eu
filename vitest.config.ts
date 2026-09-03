import { defineConfig } from 'vitest/config';
import {
  ARTIFACTS,
  COVERAGE_CRITICAL_PACKAGES,
  COVERAGE_FLOOR,
  COVERAGE_FLOOR_CRITICAL,
} from './tests/suites.js';

const floor = (value: number) => ({
  lines: value,
  functions: value,
  branches: value,
  statements: value,
});

export default defineConfig({
  test: {
    reporters: [
      'default',
      ['junit', { outputFile: ARTIFACTS.junit }],
      ['html', { outputFile: ARTIFACTS.html }],
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: ARTIFACTS.coverage,
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: ['packages/*/src/**/*.ts'],
      thresholds: {
        ...floor(COVERAGE_FLOOR),
        // Glob-keyed thresholds: these packages are held to the higher floor and are
        // taken out of the global calculation, so they cannot hide behind the rest.
        ...Object.fromEntries(
          COVERAGE_CRITICAL_PACKAGES.map((pkg) => [
            `packages/${pkg}/src/**/*.ts`,
            floor(COVERAGE_FLOOR_CRITICAL),
          ]),
        ),
      },
    },
  },
});
