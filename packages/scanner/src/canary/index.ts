import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CountryCodeSchema, HostnameSchema, type Evidence } from '@gc/contracts';
import {
  GoldenFindingSchema,
  diffGolden,
  formatGoldenDiff,
  goldenDiffEmpty,
  normaliseGolden,
  type Golden,
  type GoldenFinding,
} from '../fixtures/golden.js';
import type { CheckOutput } from '../scan.js';

// The canary (T-10): real public sites scanned nightly and compared day over day. Every
// run writes one snapshot per site: what was observed (the raw summary: hosts contacted,
// cookies set, header names, whether a policy was found) and what the scanner made of it
// (the derived findings). Comparing two days tells the two apart: a site whose raw
// summary changed changed itself; a site whose raw summary is the same but whose
// findings differ met a different scanner. That second case is the alarm.

export const CanarySiteSchema = z.object({
  host: HostnameSchema,
  country: z.union([CountryCodeSchema, z.literal('EU')]),
  sector: z.string().optional(),
  note: z.string().optional(),
});
export type CanarySite = z.infer<typeof CanarySiteSchema>;

export const CanaryCorpusSchema = z
  .object({
    version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    owner: z.object({
      name: z.string().min(1),
      contact: z.string().min(3),
      role: z.string().min(1),
    }),
    politeness: z.object({
      maxConcurrent: z.number().int().min(1).max(2),
      minIntervalMs: z.number().int().min(1000),
      passesPerSite: z.number().int().min(1).max(3),
      pagesPerSite: z.number().int().min(1).max(1),
      respectRobots: z.literal(true),
      userAgentNote: z.string().optional(),
    }),
    // Anyone who asks to be left out: the host, why, and since when. Never removed.
    exclusions: z.array(
      z.object({ host: HostnameSchema, reason: z.string().min(1), since: z.string().min(4) }),
    ),
    sites: z.array(CanarySiteSchema).min(1),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.sites.forEach((s, i) => {
      if (seen.has(s.host))
        ctx.addIssue({
          code: 'custom',
          path: ['sites', i, 'host'],
          message: `duplicate ${s.host}`,
        });
      seen.add(s.host);
    });
  });
export type CanaryCorpus = z.infer<typeof CanaryCorpusSchema>;

export const CANARY_CORPUS_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/canary/corpus.json',
);

export function loadCanaryCorpus(file: string = CANARY_CORPUS_FILE): CanaryCorpus {
  return CanaryCorpusSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

// The sites that are scanned: the corpus minus everyone who asked to be left out.
export function activeSites(corpus: CanaryCorpus): CanarySite[] {
  const out = new Set(corpus.exclusions.map((e) => e.host));
  return corpus.sites.filter((s) => !out.has(s.host));
}

// ---- snapshots ----------------------------------------------------------------------

export const RawSummarySchema = z.object({
  // Third-party hosts contacted on the passes, sorted.
  thirdPartyHosts: z.array(z.string()),
  // Cookie names set on the first load, sorted.
  cookies: z.array(z.string()),
  // Response header names seen on the site's own responses, sorted.
  headerNames: z.array(z.string()),
  policyFound: z.boolean(),
  forms: z.number().int().min(0),
});
export type RawSummary = z.infer<typeof RawSummarySchema>;

export const CanarySnapshotSchema = z.object({
  host: HostnameSchema,
  scannedAt: z.string().min(10),
  scanner: z.object({
    // The build that produced the snapshot: what to check out to reproduce it.
    commit: z.string().min(1),
    families: z.array(z.string()),
  }),
  status: z.enum(['scanned', 'unreachable', 'skipped']),
  reason: z.string().optional(),
  raw: RawSummarySchema.optional(),
  derived: z.object({ findings: z.array(GoldenFindingSchema) }).optional(),
});
export type CanarySnapshot = z.infer<typeof CanarySnapshotSchema>;

const ownHost = (site: string, host: string): boolean => {
  const base = site.toLowerCase().replace(/^www\./, '');
  return host === base || host.endsWith(`.${base}`);
};

// The raw summary from what a scan captured: only what was observed, nothing derived.
export function rawSummaryOf(
  site: string,
  evidence: readonly Evidence[],
  output: Pick<CheckOutput, 'policies' | 'formInventory'>,
): RawSummary {
  const hosts = new Set<string>();
  const cookies = new Set<string>();
  const headers = new Set<string>();
  for (const e of evidence) {
    const host = e.source.host?.toLowerCase();
    if (e.kind === 'http_request' && host && !ownHost(site, host)) hosts.add(host);
    if (e.kind === 'cookie') {
      try {
        const c = JSON.parse(e.body) as { name?: string };
        if (c.name) cookies.add(c.name);
      } catch {
        /* not a cookie body */
      }
    }
    if (e.kind === 'header' && host && ownHost(site, host)) {
      for (const line of e.body.split(/\r?\n/)) {
        const m = /^([a-z0-9-]+):/i.exec(line);
        if (m) headers.add(m[1]!.toLowerCase());
      }
    }
  }
  return {
    thirdPartyHosts: [...hosts].sort(),
    cookies: [...cookies].sort(),
    headerNames: [...headers].sort(),
    policyFound: output.policies?.observation.outcome === 'pass',
    forms: output.formInventory?.forms.length ?? 0,
  };
}

export interface SnapshotInput {
  readonly host: string;
  readonly scannedAt: string;
  readonly commit: string;
  readonly families: readonly string[];
  readonly evidence: readonly Evidence[];
  readonly output: Pick<CheckOutput, 'policies' | 'formInventory'>;
  readonly findings: readonly GoldenFinding[];
}

export function snapshotOf(input: SnapshotInput): CanarySnapshot {
  return CanarySnapshotSchema.parse({
    host: input.host,
    scannedAt: input.scannedAt,
    scanner: { commit: input.commit, families: [...input.families].sort() },
    status: 'scanned',
    raw: rawSummaryOf(input.host, input.evidence, input.output),
    derived: {
      findings: normaliseGolden({
        site: input.host,
        families: [...input.families],
        findings: [...input.findings],
      }).findings,
    },
  });
}

export const snapshotDir = (root: string, date: string): string => join(root, date);

export function writeSnapshot(root: string, date: string, snapshot: CanarySnapshot): string {
  const dir = snapshotDir(root, date);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${snapshot.host}.json`);
  writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n');
  return file;
}

export function readSnapshots(root: string, date: string): Map<string, CanarySnapshot> {
  const dir = snapshotDir(root, date);
  const out = new Map<string, CanarySnapshot>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const s = CanarySnapshotSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    out.set(s.host, s);
  }
  return out;
}

// The dates that have snapshots, oldest first.
export function snapshotDates(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

// ---- day over day ---------------------------------------------------------------------

export type CanaryChange =
  'none' | 'site-changed' | 'scanner-changed' | 'both' | 'unreachable' | 'new' | 'gone';

export interface SiteComparison {
  readonly host: string;
  readonly change: CanaryChange;
  // What changed, in words.
  readonly details: readonly string[];
  readonly findingsChanged: boolean;
  readonly alarm: boolean;
}

const rawLines = (before: RawSummary, after: RawSummary): string[] => {
  const out: string[] = [];
  const list = (name: string, a: readonly string[], b: readonly string[]) => {
    const added = b.filter((x) => !a.includes(x));
    const removed = a.filter((x) => !b.includes(x));
    if (added.length) out.push(`${name} added: ${added.join(', ')}`);
    if (removed.length) out.push(`${name} removed: ${removed.join(', ')}`);
  };
  list('third-party hosts', before.thirdPartyHosts, after.thirdPartyHosts);
  list('cookies', before.cookies, after.cookies);
  list('header names', before.headerNames, after.headerNames);
  if (before.policyFound !== after.policyFound)
    out.push(`policy ${after.policyFound ? 'found now, was not' : 'not found now, was'}`);
  if (before.forms !== after.forms) out.push(`forms ${before.forms} → ${after.forms}`);
  return out;
};

const goldenOf = (s: CanarySnapshot): Golden => ({
  site: s.host,
  families: [...s.scanner.families],
  findings: [...(s.derived?.findings ?? [])],
});

// One site, two days. The raw summary says whether the site changed; the derived
// findings say whether what the scanner made of it changed. Same raw, different
// findings is the scanner, and the alarm.
export function compareSnapshots(
  before: CanarySnapshot | undefined,
  after: CanarySnapshot | undefined,
): SiteComparison {
  const host = (after ?? before)!.host;
  if (!before)
    return {
      host,
      change: 'new',
      details: ['first snapshot'],
      findingsChanged: false,
      alarm: false,
    };
  if (!after)
    return {
      host,
      change: 'gone',
      details: ['no snapshot today'],
      findingsChanged: false,
      alarm: false,
    };
  if (after.status !== 'scanned' || before.status !== 'scanned')
    return {
      host,
      change: 'unreachable',
      details: [
        after.status === 'scanned'
          ? `was ${before.status} yesterday`
          : `${after.status}${after.reason ? `: ${after.reason}` : ''}`,
      ],
      findingsChanged: false,
      alarm: false,
    };
  const raw = rawLines(before.raw!, after.raw!);
  const diff = diffGolden(goldenOf(before), goldenOf(after));
  const derivedSame = goldenDiffEmpty(diff);
  const sameBuild = before.scanner.commit === after.scanner.commit;
  if (raw.length === 0 && derivedSame)
    return { host, change: 'none', details: [], findingsChanged: false, alarm: false };
  const derivedLines = derivedSame ? [] : formatGoldenDiff(host, diff).split('\n').slice(1);
  if (raw.length === 0)
    return {
      host,
      change: 'scanner-changed',
      details: [
        `the same observation gave different findings (${sameBuild ? 'same build ' + after.scanner.commit : `build ${before.scanner.commit} → ${after.scanner.commit}`})`,
        ...derivedLines,
      ],
      findingsChanged: true,
      alarm: true,
    };
  if (derivedSame)
    return { host, change: 'site-changed', details: raw, findingsChanged: false, alarm: false };
  return {
    host,
    change: sameBuild ? 'site-changed' : 'both',
    details: [
      ...raw,
      ...derivedLines,
      ...(sameBuild ? [] : [`build ${before.scanner.commit} → ${after.scanner.commit}`]),
    ],
    findingsChanged: true,
    alarm: !sameBuild,
  };
}

export interface CanaryReport {
  readonly before: string;
  readonly after: string;
  readonly sites: readonly SiteComparison[];
  readonly counts: Readonly<Record<CanaryChange, number>>;
  // Fleet-wide: when most of the corpus changes its findings on one night, that is the
  // scanner, whatever each site's raw summary says.
  readonly fleetShift: { changed: number; scanned: number; share: number };
  readonly alarm: boolean;
  readonly why: readonly string[];
  readonly owner: CanaryCorpus['owner'];
}

export const FLEET_SHIFT_SHARE = 0.2;

export function canaryReport(
  corpus: CanaryCorpus,
  before: { date: string; snapshots: Map<string, CanarySnapshot> },
  after: { date: string; snapshots: Map<string, CanarySnapshot> },
): CanaryReport {
  const sites = activeSites(corpus).map((s) =>
    compareSnapshots(before.snapshots.get(s.host), after.snapshots.get(s.host)),
  );
  const counts: Record<CanaryChange, number> = {
    none: 0,
    'site-changed': 0,
    'scanner-changed': 0,
    both: 0,
    unreachable: 0,
    new: 0,
    gone: 0,
  };
  for (const s of sites) counts[s.change]++;
  const scanned = sites.filter((s) => !['unreachable', 'new', 'gone'].includes(s.change)).length;
  const changedFindings = sites.filter((s) => s.findingsChanged).length;
  const share = scanned === 0 ? 0 : changedFindings / scanned;
  const why: string[] = [];
  for (const s of sites) if (s.alarm) why.push(`${s.host}: ${s.change}`);
  if (scanned >= 5 && share >= FLEET_SHIFT_SHARE)
    why.push(
      `${changedFindings} of ${scanned} sites changed their findings on one night (${Math.round(share * 100)}%): the scanner moved`,
    );
  const unreachable = counts.unreachable + counts.gone;
  if (scanned > 0 && unreachable > scanned)
    why.push(
      `${unreachable} sites unreachable against ${scanned} scanned: the runner, not the sites`,
    );
  return {
    before: before.date,
    after: after.date,
    sites,
    counts,
    fleetShift: { changed: changedFindings, scanned, share },
    alarm: why.length > 0,
    why,
    owner: corpus.owner,
  };
}

export function formatCanaryReport(r: CanaryReport): string {
  const lines = [
    `canary ${r.before} → ${r.after}: ${r.sites.length} sites; ${r.counts.none} unchanged, ${r.counts['site-changed']} site changed, ${r.counts['scanner-changed']} scanner changed, ${r.counts.both} both, ${r.counts.unreachable + r.counts.gone} unreachable, ${r.counts.new} new`,
  ];
  for (const s of r.sites) {
    if (s.change === 'none') continue;
    lines.push(`  ${s.alarm ? '!!' : '  '} ${s.host}: ${s.change}`);
    for (const d of s.details) lines.push(`       ${d}`);
  }
  if (r.alarm) {
    lines.push(`ALARM for ${r.owner.name} <${r.owner.contact}>:`);
    for (const w of r.why) lines.push(`  ${w}`);
    lines.push('  triage: docs/canary.md');
  } else lines.push('no alarm');
  return lines.join('\n');
}
