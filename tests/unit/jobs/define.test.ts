import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JOB_NAME, deadLetterName, defineJob } from '@gc/jobs';

describe('job definitions (F-06)', () => {
  it('carry the payload schema and sane defaults', () => {
    const job = defineJob({ name: 'scan-site', payload: z.object({ domain: z.string() }) });
    expect(job).toMatchObject({ name: 'scan-site', retryLimit: 2, expireInSeconds: 900 });
    expect(job.progress).toBeUndefined();
    expect(job.payload.safeParse({ domain: 'x.dk' }).success).toBe(true);
    expect(job.payload.safeParse({}).success).toBe(false);
  });

  it('refuse names that would not survive as a queue name', () => {
    for (const bad of ['', 'X', 'Scan', 'scan site', 'scan_site', '-scan', 'a'.repeat(64)]) {
      expect(JOB_NAME.test(bad), bad).toBe(false);
      expect(() => defineJob({ name: bad, payload: z.object({}) })).toThrow(/not a job name/);
    }
    expect(deadLetterName('scan-site')).toBe('scan-site--dead');
  });
});
