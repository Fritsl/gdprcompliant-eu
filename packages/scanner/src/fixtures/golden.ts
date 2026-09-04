import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { FindingSubjectSchema, FindingTypeIdSchema, SeveritySchema } from '@gc/contracts';

// Golden expectations (T-02). Where expected.json says what a fixture must and must not
// raise, golden.json says everything it does raise, finding by finding, as last accepted.
// The suite compares the two and names exactly what is missing, extra or changed; a
// golden changes only under an explicit flag, and because it is a committed file, the
// change is a diff a reviewer reads.

export const GoldenFindingSchema = z.object({
  typeId: FindingTypeIdSchema,
  severity: SeveritySchema,
  subject: FindingSubjectSchema.optional(),
});
export type GoldenFinding = z.infer<typeof GoldenFindingSchema>;

export const GoldenSchema = z.object({
  site: z.string().min(1),
  // The families the golden was produced with; a golden from fewer is not comparable.
  families: z.array(z.string().min(1)),
  findings: z.array(GoldenFindingSchema),
});
export type Golden = z.infer<typeof GoldenSchema>;

export const GOLDEN_FILE = 'golden.json';
export const UPDATE_GOLDENS_ENV = 'GC_UPDATE_GOLDENS';

export const goldenPath = (fixtureDir: string): string => join(fixtureDir, GOLDEN_FILE);

// The identity a golden entry is compared by: the finding's fingerprint, without the case.
export const goldenKey = (f: Pick<GoldenFinding, 'typeId' | 'subject'>): string =>
  [f.typeId, f.subject?.host ?? '', f.subject?.path ?? '', f.subject?.vendorId ?? ''].join('|');

export function normaliseGolden(golden: Golden): Golden {
  const findings = [...golden.findings]
    .map((f) => ({
      typeId: f.typeId,
      severity: f.severity,
      ...(f.subject && Object.keys(f.subject).length > 0 ? { subject: f.subject } : {}),
    }))
    .sort((a, b) => goldenKey(a).localeCompare(goldenKey(b)));
  return { site: golden.site, families: [...golden.families].sort(), findings };
}

export function readGolden(fixtureDir: string): Golden | undefined {
  const file = goldenPath(fixtureDir);
  if (!existsSync(file)) return undefined;
  return normaliseGolden(GoldenSchema.parse(JSON.parse(readFileSync(file, 'utf8'))));
}

export function writeGolden(fixtureDir: string, golden: Golden): void {
  writeFileSync(goldenPath(fixtureDir), JSON.stringify(normaliseGolden(golden), null, 2) + '\n');
}

export interface GoldenChange {
  readonly key: string;
  readonly before: GoldenFinding;
  readonly after: GoldenFinding;
  readonly fields: readonly string[];
}

export interface GoldenDiff {
  // In the golden, not produced now.
  readonly missing: readonly GoldenFinding[];
  // Produced now, not in the golden.
  readonly extra: readonly GoldenFinding[];
  // Same finding, different severity or subject detail.
  readonly changed: readonly GoldenChange[];
  readonly same: number;
}

export const goldenDiffEmpty = (d: GoldenDiff): boolean =>
  d.missing.length === 0 && d.extra.length === 0 && d.changed.length === 0;

export function diffGolden(expected: Golden, actual: Golden): GoldenDiff {
  const before = new Map(normaliseGolden(expected).findings.map((f) => [goldenKey(f), f]));
  const after = new Map(normaliseGolden(actual).findings.map((f) => [goldenKey(f), f]));
  const missing: GoldenFinding[] = [];
  const extra: GoldenFinding[] = [];
  const changed: GoldenChange[] = [];
  let same = 0;
  for (const [key, b] of before) {
    const a = after.get(key);
    if (!a) {
      missing.push(b);
      continue;
    }
    const fields: string[] = [];
    if (a.severity !== b.severity) fields.push('severity');
    if (JSON.stringify(a.subject ?? {}) !== JSON.stringify(b.subject ?? {})) fields.push('subject');
    if (fields.length > 0) changed.push({ key, before: b, after: a, fields });
    else same += 1;
  }
  for (const [key, a] of after) if (!before.has(key)) extra.push(a);
  return { missing, extra, changed, same };
}

const describe = (f: GoldenFinding): string => {
  const spot = `${f.subject?.host ?? ''}${f.subject?.path ?? ''}`;
  const where = spot ? ` on ${spot}` : f.subject?.vendorId ? ` for ${f.subject.vendorId}` : '';
  return `${f.typeId} (${f.severity})${where}`;
};

// The diff as a person reads it: one line per finding, saying which and what.
export function formatGoldenDiff(site: string, diff: GoldenDiff): string {
  const lines: string[] = [];
  for (const f of diff.missing)
    lines.push(`  missing  ${describe(f)}: in golden.json, not raised now`);
  for (const f of diff.extra) lines.push(`  extra    ${describe(f)}: raised now, not in golden.json`);
  for (const c of diff.changed) {
    const what = c.fields
      .map((field) =>
        field === 'severity'
          ? `severity ${c.before.severity} → ${c.after.severity}`
          : `subject ${JSON.stringify(c.before.subject ?? {})} → ${JSON.stringify(c.after.subject ?? {})}`,
      )
      .join('; ');
    lines.push(`  changed  ${c.before.typeId}: ${what}`);
  }
  const head =
    lines.length === 0
      ? `${site}: golden.json matches (${diff.same} finding(s))`
      : `${site}: golden.json differs (${diff.missing.length} missing, ${diff.extra.length} extra, ${diff.changed.length} changed, ${diff.same} same)`;
  return [head, ...lines].join('\n');
}
