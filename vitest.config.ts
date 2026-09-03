import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default', ['junit', { outputFile: 'artifacts/junit.xml' }]],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'artifacts/coverage',
      include: ['packages/*/src/**/*.ts'],
      thresholds: {
        // Raised to 85 for findings, rules and remedies once they have real code (F-08).
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
