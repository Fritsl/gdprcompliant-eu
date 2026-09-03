import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvidenceSchema, SECURITY_CHECKS, type SecurityObservation } from '@gc/contracts';
import {
  BrowserPool,
  FixtureServer,
  collectPassA,
  loadFixtureSites,
  runSecurityChecks,
} from '@gc/scanner';

// The security surface against two fixtures: one that fails every check, and the clean
// control over TLS that passes every check. And the rules the probe must keep: GET only,
// no body, the target host only, robots.txt honoured.

const sites = loadFixtureSites();
const identity = {
  tenantId: 't-1',
  caseId: 'DK-26-0M4K',
  scanId: 'scan-1',
  capturedAt: '2026-09-03T09:14:00Z',
};
let server: FixtureServer;
let pool: BrowserPool;

beforeAll(async () => {
  server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
  pool = await new BrowserPool({
    concurrency: 2,
    passTimeoutMs: 60_000,
    navigationTimeoutMs: 10_000,
    launch: { proxy: { server: server.proxy } },
    ignoreHTTPSErrors: true,
  }).start();
});

afterAll(async () => {
  await pool?.stop();
  await server?.stop();
});

const byCheck = (observations: readonly SecurityObservation[]) =>
  Object.fromEntries(observations.map((o) => [o.check, o])) as Record<
    keyof typeof SECURITY_CHECKS,
    SecurityObservation
  >;

describe('the insecure fixture fails every check, with evidence (S-12)', () => {
  it('reports each problem the fixture isolates', async () => {
    const url = 'https://usikker.test/';
    const { capture } = await collectPassA(pool, { url }, { quiet: { minDwellMs: 1_000 } });
    const before = server.served.length;
    const surface = await runSecurityChecks(pool, { url }, { capture, identity });
    const o = byCheck(surface.observations);

    expect(Object.keys(o).sort()).toEqual(Object.keys(SECURITY_CHECKS).sort());
    for (const check of Object.keys(SECURITY_CHECKS) as (keyof typeof SECURITY_CHECKS)[]) {
      expect(o[check].outcome, `${check}: ${o[check].summary}`).toBe('fail');
      expect(o[check].findingTypeId).toBe(SECURITY_CHECKS[check]);
      expect(o[check].evidence.length, check).toBeGreaterThan(0);
    }

    expect(o.transport.summary).toMatch(
      /serves pages over plain HTTP without sending the visitor to HTTPS/,
    );
    expect(o.hsts.summary).toMatch(/no Strict-Transport-Security/);
    expect(o.security_headers.detail['missing']).toEqual([
      'content-security-policy',
      'x-content-type-options',
      'x-frame-options',
    ]);

    const forms = o.form_downgrade.detail['forms'] as {
      action: string;
      fields: string[];
      redirect?: string;
      status?: number;
    }[];
    expect(forms).toEqual([
      {
        action: 'http://usikker.test/kontakt/send',
        fields: ['navn', 'email', 'besked'],
        redirect: 'https://usikker.test/kontakt/send',
        status: 301,
      },
    ]);

    // Chromium upgrades the image to https on its own; the script is what stays mixed.
    expect(o.mixed_content.detail['urls']).toEqual(['http://cdn.usikker.test/t.js']);
    expect(o.referrer_policy.detail['thirdParties']).toEqual(['cdn.usikker.test']);

    expect(o.exposed_paths.detail['exposed']).toEqual([
      { path: '/.env', looksLike: 'environment variables' },
    ]);
    expect(o.exposed_paths.detail['skippedByRobots']).toEqual(['/.env.local']);

    // Every evidence row is valid and content-addressed, and every reference resolves.
    for (const row of surface.evidence) expect(EvidenceSchema.safeParse(row).success).toBe(true);
    for (const ob of surface.observations) {
      for (const ref of ob.evidence)
        expect(surface.evidence.find((e) => e.id === ref.evidenceId)?.hash).toBe(ref.hash);
    }

    // The rules: GET only, the target host only, nothing the site disallowed.
    const made = server.served.slice(before);
    expect(made.length).toBeGreaterThan(5);
    expect(new Set(made.map((r) => r.method))).toEqual(new Set(['GET']));
    expect(new Set(made.map((r) => r.host))).toEqual(new Set(['usikker.test']));
    expect(made.map((r) => r.path)).not.toContain('/.env.local');
    expect(made.filter((r) => r.path.startsWith('/private/'))).toEqual([]);
    // The form action was requested once, with GET, and never submitted.
    expect(made.filter((r) => r.path === '/kontakt/send')).toEqual([
      { method: 'GET', scheme: 'http', host: 'usikker.test', path: '/kontakt/send', status: 301 },
    ]);
  }, 120_000);
});

describe('the clean control passes every check (S-12)', () => {
  it('finds nothing to report over TLS with good headers', async () => {
    const url = 'https://brochure.test/';
    const { capture } = await collectPassA(pool, { url }, { quiet: { minDwellMs: 1_000 } });
    const surface = await runSecurityChecks(pool, { url }, { capture, identity });
    for (const ob of surface.observations) {
      expect(ob.outcome, `${ob.check}: ${ob.summary}`).toBe('pass');
    }
    const o = byCheck(surface.observations);
    expect(o.transport.detail['location']).toBe('https://brochure.test/');
    expect(o.exposed_paths.detail['probed']).toBe(12);
  }, 120_000);

  it('a site without TLS is one failed transport check and undetermined for what needs HTTPS', async () => {
    // A host the estate serves without any certificate at all.
    const plain = await new FixtureServer([
      {
        host: 'plain.test',
        dir: sites.find((s) => s.name === 'clean-brochure')!.hosts[0]!.dir,
        routes: [],
        tls: false,
      },
    ]).start();
    const plainPool = await new BrowserPool({
      concurrency: 1,
      passTimeoutMs: 60_000,
      navigationTimeoutMs: 10_000,
      launch: { proxy: { server: plain.proxy } },
      ignoreHTTPSErrors: true,
    }).start();
    const url = 'http://plain.test/';
    const surface = await runSecurityChecks(plainPool, { url }, { identity }).finally(async () => {
      await plainPool.stop();
      await plain.stop();
    });
    const o = byCheck(surface.observations);
    expect(o.transport.outcome).toBe('fail');
    expect(o.transport.summary).toMatch(/does not answer over HTTPS/);
    expect(o.hsts.outcome).toBe('undetermined');
    expect(o.mixed_content.outcome).toBe('undetermined');
    expect(o.form_downgrade.outcome).toBe('pass');
  }, 120_000);
});
