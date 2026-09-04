// The nightly canary run (T-10): every active site in the corpus, one at a time, at the
// corpus's pace, home page only, three passes, written as one snapshot per site under
// artifacts/canary/<date>/. Never in CI's check job: this is the one script that
// reaches the internet on purpose.
//
//   pnpm canary:run                       today's date, artifacts/canary
//   CANARY_DIR=... CANARY_DATE=... CANARY_LIMIT=5 pnpm canary:run
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleFindings } from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';
import {
  BrowserPool,
  activeSites,
  loadCanaryCorpus,
  runChecks,
  benchmarkFromSnapshots,
  readSnapshots,
  snapshotOf,
  writeSnapshot,
  type CanarySnapshot,
} from '@gc/scanner';

const root = process.env['CANARY_DIR'] ?? join(process.cwd(), 'artifacts', 'canary');
const date = process.env['CANARY_DATE'] ?? new Date().toISOString().slice(0, 10);
const limit = Number(process.env['CANARY_LIMIT'] ?? '0');
const corpus = loadCanaryCorpus();
const catalogue = loadCatalogue();
const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// robots.txt: a site that disallows everyone from everything is left alone.
async function robotsAllow(host: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const r = await fetch(`https://${host}/robots.txt`, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return true;
    const text = await r.text();
    let forAll = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      if (/^user-agent:/i.test(line)) forAll = /^user-agent:\s*\*$/i.test(line);
      else if (forAll && /^disallow:\s*\/\s*$/i.test(line)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

const sites = activeSites(corpus).slice(0, limit > 0 ? limit : undefined);
const pool = await new BrowserPool({
  concurrency: corpus.politeness.maxConcurrent,
  passTimeoutMs: 60_000,
  navigationTimeoutMs: 20_000,
}).start();
const families = ['security', 'forms', 'replay', 'policies', 'consent', 'recipients'] as const;
let n = 0;
try {
  for (const site of sites) {
    n++;
    const scannedAt = new Date().toISOString();
    const base: Pick<CanarySnapshot, 'host' | 'scannedAt' | 'scanner'> = {
      host: site.host,
      scannedAt,
      scanner: { commit, families: [...families] },
    };
    if (corpus.politeness.respectRobots && !(await robotsAllow(site.host))) {
      writeSnapshot(root, date, { ...base, status: 'skipped', reason: 'robots.txt disallows everyone' });
      console.log(`${n}/${sites.length} ${site.host}: skipped (robots)`);
      continue;
    }
    try {
      const identity = {
        tenantId: 't-canary',
        caseId: 'XX-00-CNRY',
        scanId: `canary-${date}`,
        capturedAt: scannedAt,
      };
      const out = await runChecks(pool, { url: `https://${site.host}/` }, { identity, families: [...families] });
      const assembled = assembleFindings(
        {
          ...(out.security ? { security: out.security } : {}),
          ...(out.recipients ? { recipients: out.recipients } : {}),
          ...(out.forms ? { forms: out.forms } : {}),
          ...(out.replay ? { replay: out.replay } : {}),
          ...(out.policies ? { policies: out.policies } : {}),
          ...(out.consent ? { consent: out.consent } : {}),
        },
        { ...identity, jurisdiction: 'DK', catalogue, host: site.host, scanId: identity.scanId },
      );
      const snapshot = snapshotOf({
        host: site.host,
        scannedAt,
        commit,
        families,
        evidence: out.evidence,
        output: out,
        findings: assembled.findings.map((f) => ({
          typeId: f.typeId,
          severity: f.severity,
          ...(f.subject ? { subject: f.subject } : {}),
        })),
      });
      writeSnapshot(root, date, snapshot);
      console.log(
        `${n}/${sites.length} ${site.host}: ${snapshot.derived!.findings.length} finding(s), ${snapshot.raw!.thirdPartyHosts.length} third-party host(s)`,
      );
    } catch (e) {
      writeSnapshot(root, date, {
        ...base,
        status: 'unreachable',
        reason: (e as Error).message.slice(0, 200),
      });
      console.log(`${n}/${sites.length} ${site.host}: unreachable (${(e as Error).message.slice(0, 80)})`);
    }
    await sleep(corpus.politeness.minIntervalMs);
  }
} finally {
  await pool.stop();
}
// The benchmark (L-04): the distribution of open findings across the sites scanned tonight,
// beside the snapshots and where the product reads it from.
const benchmark = benchmarkFromSnapshots(date, readSnapshots(root, date).values());
const benchmarkOut = process.env['CANARY_BENCHMARK_OUT'] ?? join(process.cwd(), 'fixtures', 'canary', 'benchmark.json');
writeFileSync(join(root, date, 'benchmark.json'), JSON.stringify(benchmark, null, 2) + '\n');
writeFileSync(benchmarkOut, JSON.stringify(benchmark, null, 2) + '\n');
console.log(`canary ${date}: ${sites.length} site(s) written to ${join(root, date)}; benchmark over ${benchmark.n} site(s)`);
