import { spawnSync } from 'node:child_process';

// Rewrite the fixture goldens (T-02): the deliberate act. Runs the goldens suite with
// GC_UPDATE_GOLDENS=1, which scans every fixture, writes each golden.json and prints what
// changed; artifacts/goldens.txt keeps the full report. Commit the goldens with the change
// that caused them, so the diff is reviewed with it.

const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'vitest', 'run', '--project', 'integration', 'tests/integration/goldens.test.ts'],
  { stdio: 'inherit', env: { ...process.env, GC_UPDATE_GOLDENS: '1' }, shell: process.platform === 'win32' },
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('\ngoldens rewritten; review git diff fixtures/sites/*/golden.json and commit them with the change');
