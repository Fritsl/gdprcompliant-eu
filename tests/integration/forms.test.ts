import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EvidenceSchema,
  FORM_CHECKS,
  FormInventorySchema,
  type FormObservation,
} from '@gc/contracts';
import { BrowserPool, FixtureServer, inventoryForms, loadFixtureSites } from '@gc/scanner';

// The form inventory through a real Chromium (S-11): a fixture whose forms decide for
// the visitor, the insecure shop whose contact form says nothing, and the clean control.
// Throughout: nothing is ever submitted.

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

const byCheck = (observations: readonly FormObservation[]) =>
  Object.fromEntries(observations.map((o) => [o.check, o])) as Record<
    keyof typeof FORM_CHECKS,
    FormObservation
  >;

describe('a site whose forms decide for the visitor (S-11)', () => {
  it('finds every form on the pages that hold them, and reports the three problems with evidence', async () => {
    const { inventory, evidence } = await inventoryForms(
      pool,
      { url: 'https://tilmeld.test/' },
      { identity },
    );
    expect(FormInventorySchema.parse(inventory)).toEqual(inventory);
    for (const e of evidence) expect(EvidenceSchema.parse(e)).toEqual(e);

    expect(inventory.pages).toEqual(['/', '/tilmeld.html', '/kassen.html', '/kontakt.html']);
    expect(inventory.forms.map((f) => [f.page, f.method, f.sensitivity, f.notice.found])).toEqual([
      ['/tilmeld.html', 'post', 'contact', true],
      ['/kassen.html', 'post', 'financial', false],
      ['/kontakt.html', 'post', 'special', false],
      ['/kontakt.html', 'get', 'none', false],
    ]);
    expect(inventory.forms[1]?.fields.map((f) => [f.name, f.category])).toEqual([
      ['navn', 'contact'],
      ['email', 'contact'],
      ['adresse', 'contact'],
      ['postnummer', 'contact'],
      ['kortnummer', 'financial'],
    ]);
    expect(inventory.forms[2]?.fields.find((f) => f.name === 'symptomer')).toMatchObject({
      type: 'textarea',
      label: 'Beskriv dine symptomer',
      category: 'health',
    });

    const o = byCheck(inventory.observations);
    for (const check of Object.keys(FORM_CHECKS) as (keyof typeof FORM_CHECKS)[]) {
      expect(o[check].outcome, `${check}: ${o[check].summary}`).toBe('fail');
      expect(o[check].findingTypeId).toBe(FORM_CHECKS[check]);
      expect(o[check].evidence.length, check).toBeGreaterThan(0);
      for (const ref of o[check].evidence) {
        expect(evidence.find((e) => e.id === ref.evidenceId)?.hash).toBe(ref.hash);
      }
    }

    // Pre-ticked: in the markup, in the markup but hidden, and by script after load.
    const controls = o.preticked.detail['controls'] as {
      page: string;
      id: string;
      label: string;
      setBy: string;
      hidden: boolean;
    }[];
    expect(controls.map((c) => [c.page, c.id, c.setBy, c.hidden])).toEqual([
      ['/tilmeld.html', 'nyhedsbrev', 'markup', false],
      ['/tilmeld.html', 'profilering', 'markup', true],
      ['/kassen.html', 'sms', 'script', false],
    ]);
    expect(controls[0]?.label).toBe('Ja tak, send mig nyhedsbrevet');
    expect(o.preticked.severity).toBe('blocking');

    // Bundled: the checkout's one required box, with its exact label.
    expect(o.bundled.detail['controls']).toEqual([
      expect.objectContaining({
        page: '/kassen.html',
        id: 'accept',
        label: 'Jeg accepterer handelsbetingelserne og vil gerne modtage nyhedsbrevet',
        required: true,
      }),
    ]);
    expect(o.bundled.severity).toBe('advisory');

    // No notice: the checkout and the clinic form, not the newsletter (it has one) and
    // not the search box (it collects nothing). Card number and symptoms make it blocking.
    expect(
      (o.no_notice.detail['forms'] as { page: string; sensitivity: string }[]).map((f) => [
        f.page,
        f.sensitivity,
      ]),
    ).toEqual([
      ['/kassen.html', 'financial'],
      ['/kontakt.html', 'special'],
    ]);
    expect(o.no_notice.severity).toBe('blocking');
    expect(inventory.forms[0]?.notice).toEqual({
      found: true,
      via: 'link',
      text: 'Læs hvordan vi behandler dine oplysninger',
    });
  });

  it('never submits: every request the site saw was a GET', () => {
    const seen = server.served.filter((r) => r.host === 'tilmeld.test');
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(seen.some((r) => /\/send$/.test(r.path))).toBe(false);
  });
});

describe('the other fixtures (S-11)', () => {
  it('the insecure shop: a contact form with nothing said beside it, and no consent boxes at all', async () => {
    const { inventory } = await inventoryForms(
      pool,
      { url: 'https://usikker.test/' },
      { identity },
    );
    const o = byCheck(inventory.observations);
    expect(o.preticked.outcome).toBe('pass');
    expect(o.bundled.outcome).toBe('pass');
    expect(o.no_notice).toMatchObject({ outcome: 'fail', severity: 'serious' });
    expect(inventory.forms.map((f) => [f.page, f.fields.map((x) => x.name)])).toEqual([
      ['/', ['navn', 'email', 'besked']],
    ]);
  });

  it('the clean brochure has no forms and passes everything', async () => {
    const { inventory, evidence } = await inventoryForms(
      pool,
      { url: 'https://brochure.test/' },
      { identity },
    );
    expect(inventory.forms).toEqual([]);
    expect(evidence).toEqual([]);
    expect(inventory.observations.map((o) => [o.check, o.outcome])).toEqual([
      ['preticked', 'pass'],
      ['bundled', 'pass'],
      ['no_notice', 'pass'],
    ]);
    expect(byCheck(inventory.observations).no_notice.summary).toBe(
      'No form collects personal data.',
    );
  });
});
