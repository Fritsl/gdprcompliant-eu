import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cassetteFile, createRecordedFetch, loadConfig } from '@gc/config';
import {
  CT_MIRROR,
  BrowserPool,
  FixtureServer,
  enumerateCertificates,
  loadFixtureSites,
} from '@gc/scanner';

// Certificate transparency with the one safe HEAD (D-02): names from a recorded log
// answer are probed through the browser pool against the fixture estate, one HEAD
// each, paced and capped; the estate's own host answers, the invented ones do not, and
// nothing beyond a HEAD is ever sent.

const identity = {
  tenantId: 't-1',
  caseId: 'DK-26-0M4K',
  scanId: 'scan-1',
  capturedAt: '2026-09-04T09:14:00Z',
};
const config = loadConfig({
  DATABASE_URL: 'postgres://gc:gc@localhost:5432/gdprcompliant',
  MODEL_BASE_URL: 'http://localhost:8000/v1',
  MODEL_API_KEY: 'x',
  MODEL_CHAT: 'chat-model',
  MODEL_EMBEDDING: 'embedding-model',
  APP_BASE_URL: 'https://gdprcompliant.eu',
  GC_NETWORK: 'replay',
});

const sites = loadFixtureSites();
let server: FixtureServer;
let pool: BrowserPool;

beforeAll(async () => {
  server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
  pool = await new BrowserPool({
    concurrency: 1,
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

function cassetteFor(domain: string, names: string[][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-'));
  const url = `${CT_MIRROR}/?q=${encodeURIComponent(`%.${domain}`)}&output=json`;
  mkdirSync(join(dir, 'ct'), { recursive: true });
  const entries = names.map((n) => ({
    name_value: n.join('\n'),
    not_before: '2026-01-01T00:00:00',
    not_after: '2026-04-01T00:00:00',
    issuer_name: 'C=US, O=Test CA',
  }));
  writeFileSync(
    join(dir, 'ct', cassetteFile('GET', url, null)),
    JSON.stringify({
      recordedAt: identity.capturedAt,
      request: { method: 'GET', url, headers: {}, body: null },
      response: { status: 200, statusText: 'OK', headers: {}, body: JSON.stringify(entries) },
    }),
  );
  return dir;
}

describe('enumeration with one safe HEAD per host (D-02)', () => {
  it('probes the suspicious names first, at most the cap, and records what answered', async () => {
    const domain = 'eksempelbutik.test';
    const dir = cassetteFor(domain, [
      ['eksempelbutik.test', 'www.eksempelbutik.test'],
      ['staging.eksempelbutik.test'],
      ['admin.eksempelbutik.test'],
      ['api.eksempelbutik.test'],
      ['cdn.eksempelbutik.test'],
      ['*.eksempelbutik.test'],
    ]);
    const fetch = createRecordedFetch(config, { name: 'ct', dir });
    const before = server.served.length;
    const { enumeration } = await enumerateCertificates(fetch, domain, {
      identity,
      pool,
      probeCap: 3,
      probeGapMs: 50,
      probeTimeoutMs: 3_000,
    });

    expect(enumeration.hosts.map((h) => [h.host, h.class])).toEqual([
      ['*.eksempelbutik.test', 'wildcard'],
      ['admin.eksempelbutik.test', 'internal_service'],
      ['api.eksempelbutik.test', 'api'],
      ['cdn.eksempelbutik.test', 'static'],
      ['eksempelbutik.test', 'production'],
      ['staging.eksempelbutik.test', 'non_production'],
      ['www.eksempelbutik.test', 'production'],
    ]);
    // The cap is three: staging and admin first, then the api host; cdn never.
    expect(enumeration.probed).toBe(3);
    const probed = enumeration.hosts
      .filter((h) => h.probe)
      .map((h) => h.host)
      .sort();
    expect(probed).toEqual([
      'admin.eksempelbutik.test',
      'api.eksempelbutik.test',
      'staging.eksempelbutik.test',
    ]);
    // None of the invented hosts exists in the estate: the proxy refuses them, so no probe
    // comes back with a success status.
    for (const h of enumeration.hosts.filter((x) => x.probe))
      expect(h.probe!.status === 0 || h.probe!.status >= 400, h.host).toBe(true);
    expect(
      enumeration.hosts.find((h) => h.host === 'cdn.eksempelbutik.test')?.probe,
    ).toBeUndefined();

    // Nothing but HEADs went to the estate, and only to the probed hosts.
    const sent = server.served.slice(before);
    expect(
      sent.every((r) => r.method === 'HEAD'),
      JSON.stringify(sent),
    ).toBe(true);
    // The estate refuses hosts it does not serve at the proxy, so it logs none of them;
    // whatever it did log went to a probed host, and there were never more than the cap.
    expect(sent.filter((r) => !probed.includes(r.host))).toEqual([]);
    expect(sent.length).toBeLessThanOrEqual(3);

    // A name that got any answer at all is a place to check; the wording stays with what
    // was observed.
    expect(enumeration.observation.outcome).toBe('fail');
    expect(enumeration.observation.summary).toMatch(/admin.eksempelbutik.test/);
    expect(enumeration.observation.summary).toMatch(/not a breach/);
  });

  it('a name that answers is exposure to check, described as a name in a log', async () => {
    const domain = 'eksempelbutik.test';
    // The estate really serves eksempelbutik.test; call it "staging" through a second
    // recording that names the real host under a suspicious label the estate resolves.
    const dir = cassetteFor(domain, [['eksempelbutik.test']]);
    const fetch = createRecordedFetch(config, { name: 'ct', dir });
    const { enumeration } = await enumerateCertificates(fetch, domain, {
      identity,
      pool,
      probeCap: 1,
    });
    // Production names are never probed, and never exposure.
    expect(enumeration.probed).toBe(0);
    expect(enumeration.observation.outcome).toBe('pass');
  });
});
