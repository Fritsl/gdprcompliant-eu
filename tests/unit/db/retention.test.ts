import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RETENTION, RETENTION_CRON, RETENTION_JOB } from '@gc/db';
import { tablesInSnapshot } from '../../../scripts/rls-check.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// The retention declarations (O-02): complete against the schema, sane, and documented.

describe('retention declarations', () => {
  it('cover every table in the schema snapshot, and nothing else', () => {
    expect(Object.keys(RETENTION).sort()).toEqual(tablesInSnapshot().sort());
  });

  it('every rule with a clock has a positive one, and the anonymous stub is the only thing kept forever un-shared', () => {
    for (const [table, rule] of Object.entries(RETENTION)) {
      if (rule.kind === 'months') expect(rule.months, table).toBeGreaterThan(0);
      if (rule.kind === 'case') {
        expect(rule.unclaimedDays, table).toBeGreaterThan(0);
        expect(rule.graceDays, table).toBeGreaterThanOrEqual(0);
      }
      if (rule.kind === 'claim') expect(rule.tailDays, table).toBeGreaterThan(0);
    }
    const forever = Object.entries(RETENTION).filter(([, r]) => r.kind === 'anonymous_forever');
    expect(forever.map(([t]) => t)).toEqual(['deletion_audit']);
  });

  it('is documented, table by table, and the CI check exists', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'decisions', 'retention.md'), 'utf8');
    for (const table of Object.keys(RETENTION)) expect(doc, table).toContain(table);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['check:retention']).toMatch(/retention-check/);
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain('pnpm check:retention');
  });

  it('the sweep job has a nightly schedule and refuses a clock that is not a date', () => {
    expect(RETENTION_CRON).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(RETENTION_JOB.payload.safeParse({ now: 'yesterday' }).success).toBe(false);
    expect(RETENTION_JOB.payload.safeParse({ now: '2026-09-03T09:14:00Z' }).success).toBe(true);
    expect(RETENTION_JOB.payload.safeParse({}).success).toBe(true);
  });
});
