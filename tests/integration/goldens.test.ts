import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleFindings, type AssemblyInput } from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';
import {
  BrowserPool,
  FixtureServer,
  UPDATE_GOLDENS_ENV,
  diffGolden,
  formatGoldenDiff,
  goldenDiffEmpty,
  loadFixtureSites,
  readGolden,
  runChecks,
  writeGolden,
  type Golden,
} from '@gc/scanner';

// Goldens (T-02): every fixture's golden.json is the full set of findings it raised when
// someone last accepted it. This suite scans each fixture and compares, naming exactly
// what is missing, extra or changed. With GC_UPDATE_GOLDENS=1 it rewrites the goldens
// instead and prints what changed; the files are committed, so the change is a diff in
// review, never a silent drift.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARTIFACTS = join(ROOT, 'artifacts');
const all = loadFixtureSites();
const estate = all.filter((s) => !s.expected.tags.includes('adversarial'));
const FAMILIES = ['security', 'forms', 'replay', 'policies', 'consent', 'recipients'] as const;
const catalogue = loadCatalogue();
const T0 = new Date('2026-09-04T09:14:00Z');
const updating = process.env[UPDATE_GOLDENS_ENV] === '1';
let server: FixtureServer;
let pool: BrowserPool;
const report: string[] = [];

const urlOf = (site: (typeof all)[number]) =>
  `${site.hosts.some((h) => h.routes.some((r) => r.scheme === 'http')) ? 'https' : 'http'}://${site.expected.site}/`;

async function produce(site: (typeof all)[number]): Promise<Golden> {
  const identity = {
    tenantId: 't-golden',
    caseId: 'DK-26-GOLD',
    scanId: `golden-${site.name}`,
    capturedAt: T0.toISOString(),
  };
  const out = await runChecks(pool, { url: urlOf(site) }, { identity, families: [...FAMILIES] });
  const input: AssemblyInput = {
    ...(out.security ? { security: out.security } : {}),
    ...(out.recipients ? { recipients: out.recipients } : {}),
    ...(out.forms ? { forms: out.forms } : {}),
    ...(out.replay ? { replay: out.replay } : {}),
    ...(out.policies ? { policies: out.policies } : {}),
    ...(out.consent ? { consent: out.consent } : {}),
  };
  const { findings } = assembleFindings(input, {
    ...identity,
    jurisdiction: 'DK',
    catalogue,
    host: site.expected.site,
    now: () => T0,
  });
  return {
    site: site.expected.site,
    families: [...FAMILIES],
    findings: findings.map((f) => ({
      typeId: f.typeId,
      severity: f.severity,
      ...(f.subject ? { subject: f.subject } : {}),
    })),
  };
}

beforeAll(async () => {
  server = await new FixtureServer(all.flatMap((s) => s.hosts)).start();
  pool = await new BrowserPool({
    concurrency: 3,
    passTimeoutMs: 60_000,
    navigationTimeoutMs: 15_000,
    launch: { proxy: { server: server.proxy } },
    ignoreHTTPSErrors: true,
    resolveEgress: false,
  }).start();
  mkdirSync(ARTIFACTS, { recursive: true });
}, 120_000);

afterAll(async () => {
  await pool?.stop();
  await server?.stop();
  writeFileSync(join(ARTIFACTS, 'goldens.txt'), report.join('\n\n') + '\n');
});

describe(updating ? 'goldens, being rewritten' : 'goldens, held to', () => {
  it.each(estate.map((s) => [s.name, s] as const))(
    '%s',
    async (_, site) => {
      const actual = await produce(site);
      const golden = readGolden(site.dir);
      if (updating) {
        const diff = golden
          ? diffGolden(golden, actual)
          : { missing: [], extra: actual.findings, changed: [], same: 0 };
        writeGolden(site.dir, actual);
        const text = formatGoldenDiff(site.name, diff);
        report.push(text);
        console.log(
          golden
            ? text
            : `${site.name}: golden.json written (${actual.findings.length} finding(s))`,
        );
        return;
      }
      expect(
        golden,
        `${site.name} has no golden.json; run pnpm goldens:update and commit it`,
      ).toBeDefined();
      expect(golden!.families, `${site.name}: golden produced with different families`).toEqual(
        [...FAMILIES].sort(),
      );
      const diff = diffGolden(golden!, actual);
      const text = formatGoldenDiff(site.name, diff);
      report.push(text);
      expect(
        goldenDiffEmpty(diff),
        `\n${text}\nIf this is intended: pnpm goldens:update, then commit golden.json.`,
      ).toBe(true);
    },
    180_000,
  );
});
