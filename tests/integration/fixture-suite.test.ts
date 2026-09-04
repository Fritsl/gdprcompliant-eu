import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_TAGS, type FindingTypeId } from '@gc/contracts';
import { DETECTORS, assembleFindings, checkFamilyFor, type AssemblyInput } from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';
import { BrowserPool, FixtureServer, loadFixtureSites, runChecks } from '@gc/scanner';

// The fixture site suite (T-01): every fixture is scanned the way a case is, and what it
// raises is held against its expected.json. A must that is not raised or a mustNot that
// is fails the suite; a clean control that raises anything at all fails it. Over the
// whole estate, every finding type the scanner can raise from a page has a fixture that
// proves it fires and one that proves it does not; the awkward cases are each covered;
// and a new fixture is a directory, never a code change.

const all = loadFixtureSites();
// The hostile fixtures belong to the adversarial suite (T-06).
const estate = all.filter((s) => !s.expected.tags.includes('adversarial'));
const FAMILIES = ['security', 'forms', 'replay', 'policies', 'consent'] as const;
const catalogue = loadCatalogue();
const T0 = new Date('2026-09-04T09:14:00Z');
let server: FixtureServer;
let pool: BrowserPool;
const raised = new Map<string, Set<string>>();

const urlOf = (site: (typeof all)[number]) =>
  `${site.hosts.some((h) => h.routes.some((r) => r.scheme === 'http')) ? 'https' : 'http'}://${site.expected.site}/`;

async function scan(site: (typeof all)[number]): Promise<Set<string>> {
  const identity = {
    tenantId: 't-suite',
    caseId: 'DK-26-SUIT',
    scanId: `suite-${site.name}`,
    capturedAt: T0.toISOString(),
  };
  // The scanner's own dwell, so a tag that arrives late is seen the way a visitor sees it.
  const out = await runChecks(pool, { url: urlOf(site) }, { identity, families: [...FAMILIES] });
  const input: AssemblyInput = {
    ...(out.security ? { security: out.security } : {}),
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
  return new Set(findings.map((f) => f.typeId));
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
}, 120_000);

afterAll(async () => {
  await pool?.stop();
  await server?.stop();
});

describe('every fixture raises what it says, and nothing it forbids', () => {
  it.each(estate.map((s) => [s.name, s] as const))(
    '%s',
    async (_, site) => {
      const types = await scan(site);
      raised.set(site.name, types);
      for (const id of site.expected.findings.must)
        expect(
          types.has(id),
          `${site.name} must raise ${id}; raised ${[...types].join(', ')}`,
        ).toBe(true);
      for (const id of site.expected.findings.mustNot)
        expect(types.has(id), `${site.name} must not raise ${id}`).toBe(false);
      if (site.expected.tags.includes('clean'))
        expect([...types], `${site.name} is a clean control`).toEqual([]);
    },
    180_000,
  );
});

describe('the estate as a whole', () => {
  it('has at least four clean controls, and they raise nothing at all', () => {
    const clean = estate.filter((s) => s.expected.tags.includes('clean'));
    expect(clean.length).toBeGreaterThanOrEqual(4);
    for (const s of clean) expect(raised.get(s.name), s.name).toEqual(new Set());
  });

  it('every finding type the scanner raises from a page has a positive and a negative fixture', () => {
    const fromPages = DETECTORS.filter((d) => {
      const family = checkFamilyFor(d.findingTypeId);
      return family !== undefined && family !== 'ct';
    }).map((d) => d.findingTypeId);
    expect(fromPages.length).toBeGreaterThan(15);
    // Across the whole estate, hostile fixtures included: the adversarial suite proves those.
    const positives = new Set<string>(all.flatMap((s) => s.expected.findings.must));
    const negatives = new Set<string>(all.flatMap((s) => s.expected.findings.mustNot));
    for (const id of fromPages) {
      expect(positives.has(id), `${id} has no fixture that must raise it`).toBe(true);
      expect(negatives.has(id), `${id} has no fixture that must not raise it`).toBe(true);
    }
    // And what a fixture says it must raise, it did; what it says it must not, it did not.
    for (const s of estate) {
      const types = raised.get(s.name)!;
      for (const id of s.expected.findings.must)
        expect(types.has(id as FindingTypeId), `${s.name}: ${id}`).toBe(true);
    }
  });

  it('covers the awkward cases: lazy-loaded trackers, shadow DOM, iframes, single-page apps, consent in localStorage', () => {
    const tags = new Set(estate.flatMap((s) => s.expected.tags));
    for (const tag of [
      'lazy-load',
      'shadow-dom',
      'iframe',
      'spa',
      'local-storage-consent',
      'clean',
    ])
      expect(tags.has(tag as (typeof FIXTURE_TAGS)[number]), tag).toBe(true);
  });

  it('is twenty-five sites or more, each a directory with nothing to register anywhere', () => {
    expect(all.length).toBeGreaterThanOrEqual(25);
    const names = all.map((s) => s.name);
    expect(names).toEqual([...names].sort());
    // Two fixtures cannot answer to one host name: the server keeps one of each.
    const hosts = all.flatMap((s) => s.hosts.map((h) => h.host));
    expect(new Set(hosts).size).toBe(hosts.length);
  });
});
