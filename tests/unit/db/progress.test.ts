import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { progressFromFindings } from '@gc/db';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Shared progress (P-03): counts per desk with nothing that names a finding, and
// reminders that only an owner can start.

describe('progress from findings', () => {
  it('counts open and done per desk, never names a finding, and reads 100% when there is nothing to do', () => {
    const p = progressFromFindings('DK-26-0M4K', 'working', [
      { typeId: 'CNS-02', area: 'Consent', status: 'closed' },
      { typeId: 'CNS-01', area: 'Consent', status: 'open' },
      { typeId: 'FRM-02', area: 'Collection', status: 'working' },
      { typeId: 'SEC-03', area: 'Security', status: 'open' },
      { typeId: 'TRF-01', area: 'Transfers', status: 'regressed' },
    ]);
    expect(p).toEqual({
      caseId: 'DK-26-0M4K',
      stage: 'working',
      roles: [
        { role: 'marketing', open: 2, done: 1 },
        { role: 'it', open: 1, done: 0 },
        { role: 'hr', open: 0, done: 0 },
        { role: 'finance', open: 1, done: 0 },
      ],
      open: 4,
      done: 1,
      percent: 20,
    });
    expect(JSON.stringify(p)).not.toMatch(/CNS|FRM|SEC|TRF/);
    expect(progressFromFindings('DK-26-0M4K', 'opened', []).percent).toBe(100);
  });
});

describe('reminders are owner-initiated', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', 'dist', '.next', 'migrations'].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  it('the only code path that writes a reminder is remindMember; no job or sweep sends one', () => {
    const files = [join(ROOT, 'packages'), join(ROOT, 'apps')].flatMap((d) => walk(d));
    const writers = files.filter(
      (f) =>
        /'reminder'/.test(readFileSync(f, 'utf8')) &&
        readFileSync(f, 'utf8').includes('queueMail('),
    );
    expect(writers.map((f) => f.replace(ROOT, '').split('\\').join('/'))).toEqual([
      'packages/db/src/members.ts',
    ]);
    const members = readFileSync(join(ROOT, 'packages', 'db', 'src', 'members.ts'), 'utf8');
    // One call site, inside remindMember, which only the owner's route reaches.
    const calls = members.split('await queueMail(').slice(1);
    const reminderCalls = calls.filter((c) => c.slice(0, 200).includes("'reminder'"));
    expect(reminderCalls).toHaveLength(1);
    const remindAt = members.indexOf('export async function remindMember');
    const callAt = members.indexOf('await queueMail(', remindAt);
    expect(callAt).toBeGreaterThan(remindAt);
    expect(members.slice(callAt, callAt + 200)).toContain("'reminder'");
    const retention = readFileSync(join(ROOT, 'packages', 'db', 'src', 'retention.ts'), 'utf8');
    const job = readFileSync(join(ROOT, 'packages', 'db', 'src', 'retention-job.ts'), 'utf8');
    expect(retention + job).not.toMatch(/remind/i);
  });
});
