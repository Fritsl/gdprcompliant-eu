import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHOICE_NOT_REMEMBERED_FINDING, PassCaptureSchema } from '@gc/contracts';
import {
  BrowserPool,
  FixtureServer,
  collectPassB,
  collectPassC,
  collectPasses,
  loadFixtureSites,
  vendorHostsOf,
} from '@gc/scanner';

// Pass B and Pass C (S-04): the refused and the accepted visit, each recorded on the
// reload after the choice, in the same shape as Pass A. A refusal counts as registered
// only when something was written and the banner stays away; a banner that forgets is
// the finding. Pass C's hosts are the vendor inventory. All three passes run together
// inside the budget.

const sites = loadFixtureSites();
const identity = {
  tenantId: 't-1',
  caseId: 'DK-26-0M4K',
  scanId: 'scan-1',
  capturedAt: '2026-09-04T09:14:00Z',
};
const quiet = { minDwellMs: 800, quietMs: 400, maxWaitMs: 8_000 };
let server: FixtureServer;
let pool: BrowserPool;

beforeAll(async () => {
  server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
  pool = await new BrowserPool({
    concurrency: 3,
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

const expectedOf = (name: string) => sites.find((s) => s.name === name)!.expected;

describe('Pass B: the refused visit', () => {
  it('refuses, checks the refusal was registered, and records the reload alone', async () => {
    const { capture, refusal, evidence } = await collectPassB(
      pool,
      { url: 'http://eksempelbutik.test/' },
      { identity, quiet },
    );
    expect(PassCaptureSchema.safeParse(capture).success).toBe(true);
    expect(capture.pass).toBe('B');
    expect(refusal.outcome, refusal.summary).toBe('refused');
    expect(refusal.platform).toBe('generic');
    expect(evidence.length).toBe(refusal.steps.length);

    // Registered: something was written to remember it, and the banner stayed away.
    expect(capture.consent).toMatchObject({
      action: 'refuse',
      outcome: 'refused',
      rememberedAfterReload: true,
    });
    expect(capture.consent!.recordedIn.cookies).toContain('cmp_consent');
    expect(capture.consent!.recordedIn.storage).toContain('local:cmp-choice');
    expect(capture.consent!.finding).toBeUndefined();
    expect(capture.cookies.find((c) => c.name === 'cmp_consent')?.value).toBe('reject');

    // The reload alone: the document once, and what the fixture promised after a refusal.
    const documents = capture.requests.filter((r) => r.resourceType === 'document');
    expect(documents).toHaveLength(1);
    const hosts = new Set(capture.requests.map((r) => r.host));
    for (const h of expectedOf('reject-not-honoured').network.afterReject!.mustContact) {
      expect(hosts.has(h), h).toBe(true);
    }
    expect(capture.startedAt >= refusal.startedAt).toBe(true);
  });

  it('a banner that forgets the refusal is the finding, with the reload showing it again', async () => {
    const { capture, refusal } = await collectPassB(
      pool,
      { url: 'https://glemsom.test/' },
      { identity, quiet },
    );
    expect(refusal.outcome, refusal.summary).toBe('refused');
    expect(capture.consent).toMatchObject({
      action: 'refuse',
      outcome: 'refused',
      rememberedAfterReload: false,
      finding: { findingTypeId: CHOICE_NOT_REMEMBERED_FINDING },
    });
    expect(capture.consent!.recordedIn).toEqual({ cookies: [], storage: [] });
    expect(expectedOf('banner-forgets').consent?.rememberedAfterReload).toBe(false);
  });

  it('a page without a banner is a plain reload, with no consent finding', async () => {
    const { capture, refusal } = await collectPassB(
      pool,
      { url: 'https://brochure.test/' },
      { identity, quiet },
    );
    expect(refusal.outcome).toBe('no_banner');
    expect(capture.consent).toMatchObject({ action: 'refuse', outcome: 'no_banner', steps: 1 });
    expect(capture.consent!.finding).toBeUndefined();
  });
});

describe('Pass C: the accepted visit', () => {
  it('accepts, checks the acceptance stuck, and hands over the permitted vendor set', async () => {
    const { capture, steps, vendorHosts } = await collectPassC(
      pool,
      { url: 'http://eksempelbutik.test/' },
      { identity, quiet },
    );
    expect(capture.pass).toBe('C');
    expect(capture.consent).toMatchObject({
      action: 'accept',
      outcome: 'accepted',
      platform: 'generic',
      rememberedAfterReload: true,
    });
    expect(steps.map((s) => s.action)).toEqual(['found', 'click', 'hidden']);
    expect(steps[1]!.target).toBe('Accepter alle');
    expect(capture.cookies.find((c) => c.name === 'cmp_consent')?.value).toBe('accept');
    for (const h of expectedOf('reject-not-honoured').network.afterAccept!.mustContact) {
      expect(vendorHosts, h).toContain(h);
    }
    expect(vendorHosts).toEqual(vendorHostsOf(capture));
    expect(vendorHosts).not.toContain('eksempelbutik.test');
  });

  it('accepts through a platform signature too', async () => {
    const { capture } = await collectPassC(
      pool,
      { url: 'https://onetrust-shop.test/' },
      { identity, quiet },
    );
    expect(capture.consent).toMatchObject({
      action: 'accept',
      outcome: 'accepted',
      platform: 'onetrust',
    });
    expect(capture.consent!.recordedIn.cookies).toContain('OptanonConsent');
  });
});

describe('all three passes', () => {
  it('run concurrently, agree on the site, and finish inside the budget', async () => {
    const all = await collectPasses(
      pool,
      { url: 'http://eksempelbutik.test/' },
      { identity, quiet },
    );
    expect(all.a.capture.pass).toBe('A');
    expect(all.b.capture.pass).toBe('B');
    expect(all.c.capture.pass).toBe('C');
    for (const c of [all.a.capture, all.b.capture, all.c.capture]) {
      expect(c.finalUrl).toBe('http://eksempelbutik.test/');
      expect(c.document?.lang).toBe('da');
    }
    // Refusing changed nothing on this site: the same trackers on every pass, which is
    // what the differ (S-05) will turn into CNS-02.
    const hostsOf = (r: { requests: { host: string }[] }) =>
      [...new Set(r.requests.map((x) => x.host))].sort();
    expect(hostsOf(all.b.capture)).toEqual(hostsOf(all.c.capture));
    // Three passes, each with a dwell of at least 800 ms, in well under three times one.
    expect(all.durationMs).toBeLessThan(30_000);
    console.log(`three passes in ${all.durationMs} ms`);
  });
});
