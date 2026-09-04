import { afterAll, describe, expect, it } from 'vitest';
import { assembleFindings, type AssemblyInput } from '@gc/findings';
import { headersFromSnippet, loadCatalogue, loadGuides, loadSnippetProofs } from '@gc/remedies';
import {
  BrowserPool,
  FixtureServer,
  applyOverrides,
  loadFixtureSites,
  runChecks,
  type FixtureHost,
} from '@gc/scanner';

// The guides (R-03): every snippet is shown to work against a fixture that starts broken
// and ends fixed, in a real browser; and every guide reads as a page a non-specialist
// can land on from a search: a plain title, words a person would search for, and no law
// quoted in the guide itself, because the binding does that for the reader's country.

const sites = loadFixtureSites();
const catalogue = loadCatalogue();
const guides = loadGuides();
const { proofs } = loadSnippetProofs();
const T0 = new Date('2026-09-04T09:14:00Z');
const identity = {
  tenantId: 't-guide',
  caseId: 'DK-26-GUID',
  scanId: 'guides',
  capturedAt: T0.toISOString(),
};
const quiet = { minDwellMs: 1_500, quietMs: 500, maxWaitMs: 8_000 };

const urlOf = (site: (typeof sites)[number]) =>
  `${site.hosts.some((h) => h.routes.some((r) => r.scheme === 'http')) ? 'https' : 'http'}://${site.expected.site}/`;

type Family = 'security' | 'forms' | 'replay' | 'policies' | 'consent' | 'recipients';

// One scan of one site, on its own estate, with the family the proof names.
async function raisedBy(
  site: (typeof sites)[number],
  hosts: FixtureHost[],
  family: Family,
): Promise<Set<string>> {
  const server = await new FixtureServer(hosts).start();
  const pool = await new BrowserPool({
    concurrency: 2,
    passTimeoutMs: 60_000,
    navigationTimeoutMs: 15_000,
    launch: { proxy: { server: server.proxy } },
    ignoreHTTPSErrors: true,
    resolveEgress: false,
  }).start();
  try {
    // The consent family needs the scanner's own dwell for a tag that arrives late.
    const out = await runChecks(
      pool,
      { url: urlOf(site) },
      {
        identity,
        // Replay is judged on the pages the form inventory finds, so it runs with forms.
        families: family === 'replay' ? ['forms', 'replay'] : [family],
        ...(family === 'consent' ? {} : { quiet }),
      },
    );
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
    return new Set(findings.map((f) => f.typeId));
  } finally {
    await pool.stop();
    await server.stop();
  }
}

const broken = new Map<string, Promise<Set<string>>>();
const brokenRun = (site: (typeof sites)[number], family: Family) => {
  const key = `${site.name}:${family}`;
  let p = broken.get(key);
  if (!p) {
    p = raisedBy(
      site,
      sites.flatMap((s) => s.hosts),
      family,
    );
    broken.set(key, p);
  }
  return p;
};

afterAll(() => broken.clear());

describe('every snippet takes its fixture from broken to fixed', () => {
  const proved = proofs.filter((p) => !p.exempt);
  it.each(proved.map((p) => [p.remedyId, p] as const))(
    '%s',
    async (_, proof) => {
      const site = sites.find((s) => s.name === proof.fixture)!;
      const host = site.hosts.find((h) => h.host === proof.host)!;
      const remedy = catalogue.get(proof.remedyId)!.remedy;
      const headers = {
        ...headersFromSnippet(remedy.kind === 'self_fix' ? (remedy.snippet ?? '') : ''),
        ...(proof.headers ?? {}),
      };
      const fixed = applyOverrides(host, {
        headers,
        ...(proof.routes ? { routes: proof.routes } : {}),
        ...(proof.replaceRoutes ? { replaceRoutes: true } : {}),
        ...(proof.replace ? { replace: proof.replace } : {}),
      });
      const family = proof.family as Family;
      const before = await brokenRun(site, family);
      expect(
        before.has(proof.findingTypeId),
        `${proof.fixture} must start broken: ${proof.findingTypeId}`,
      ).toBe(true);
      const hosts = sites.flatMap((s) => s.hosts).map((h) => (h === host ? fixed : h));
      const after = await raisedBy(site, hosts, family);
      expect(
        after.has(proof.findingTypeId),
        `${proof.remedyId} applied to ${proof.fixture}: ${proof.findingTypeId} still raised (${[...after].join(', ')})`,
      ).toBe(false);
    },
    240_000,
  );

  it('every exemption says why, and only the certificate-log type is exempt', () => {
    for (const p of proofs.filter((p) => p.exempt)) {
      expect(p.exempt!.length).toBeGreaterThan(40);
      expect(p.findingTypeId).toBe('EXP-01');
    }
  });
});

describe('every guide stands up as a page', () => {
  it.each(guides.guides.map((g) => [g.id, g] as const))('%s', (_, g) => {
    for (const locale of ['en', 'da'] as const) {
      const title = g.title[locale]!;
      expect(title.length).toBeGreaterThan(20);
      expect(title.length).toBeLessThan(90);
      // A person searches in words, not in codes: at least two keyword phrases.
      expect(g.keywords.filter((k) => k[locale]).length).toBeGreaterThanOrEqual(2);
      const body = [
        g.wrong[locale],
        g.why[locale],
        ...g.steps.map((s) => s[locale]),
        g.confirm[locale],
      ].join(' ');
      expect(body.split(/\s+/).length, `${g.id} ${locale} body`).toBeGreaterThan(120);
      // The guide never quotes law itself; the binding does, for the reader's country.
      expect(body).not.toMatch(/\bArt(?:\.|icle|ikel)\s*\d|§\s*\d|\(EU\)\s*2016\/679/);
      // No finding code in the prose: the reader has a problem, not a catalogue id.
      expect(body).not.toMatch(/\b[A-Z]{3}-\d{2}\b/);
      for (const s of g.steps)
        expect(s[locale]!.split(/\s+/).length, `${g.id} step ${locale}`).toBeGreaterThan(8);
    }
    // The remedy the guide names is the remedy the finding gets.
    if (g.remedyId) {
      const entry = catalogue.get(g.remedyId)!;
      expect(entry.remedy.findingTypeId).toBe(g.findingTypeId);
    }
  });
});
