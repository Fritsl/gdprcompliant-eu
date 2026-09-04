import { describe, expect, it } from 'vitest';
import {
  CONSENT_FINDINGS,
  PassDiffSchema,
  sha256,
  type CapturedRequest,
  type ConsentRefusal,
  type ConsentStep,
  type PassCapture,
} from '@gc/contracts';
import { diffPasses } from '@gc/scanner';

// The three-pass differ (S-05), on captures built by hand: which hosts count as tracking
// and why, which findings the diff raises and with which hosts, and that a site that
// behaves raises nothing.

const SITE = 'http://shop.test/';
const identity = {
  tenantId: 't-1',
  caseId: 'DK-26-0M4K',
  scanId: 'scan-1',
  capturedAt: '2026-09-04T09:14:00Z',
};

const request = (url: string, over: Partial<CapturedRequest> = {}): CapturedRequest => ({
  url,
  host: new URL(url).hostname,
  method: 'GET',
  resourceType: url.endsWith('.js')
    ? 'script'
    : url.includes('collect') || url.includes('px')
      ? 'image'
      : 'document',
  frameUrl: SITE,
  initiator: { type: 'parser' },
  chain: [],
  startedAtMs: 0,
  status: 200,
  ...over,
});

function capture(
  pass: 'A' | 'B' | 'C',
  requests: CapturedRequest[],
  over: Partial<PassCapture> = {},
): PassCapture {
  return {
    pass,
    url: SITE,
    finalUrl: SITE,
    status: 200,
    startedAt: '2026-09-04T09:14:00Z',
    frames: [SITE],
    requests: [request(SITE), ...requests],
    cookies: [],
    storage: [],
    quiet: { reachedQuiet: true, waitedMs: 1000, lastRequestAtMs: 500 },
    ...over,
  } as PassCapture;
}

const screenshot = { evidenceId: `screenshot:${sha256('s').slice(0, 16)}`, hash: sha256('s') };
const step = (n: number, action: ConsentStep['action'], target: string): ConsentStep => ({
  n,
  action,
  target,
  at: '2026-09-04T09:14:00Z',
  screenshot,
});
const refusal = (
  steps: ConsentStep[],
  outcome: ConsentRefusal['outcome'] = 'refused',
): ConsentRefusal => ({
  url: SITE,
  startedAt: '2026-09-04T09:14:00Z',
  bannerFound: outcome !== 'no_banner',
  ...(outcome !== 'no_banner'
    ? { platform: 'generic' as const, recognisedBy: 'heuristic' as const }
    : {}),
  outcome,
  summary: 'test',
  steps,
  bannerHiddenAfter: outcome === 'refused' || outcome === 'no_banner',
  ...(outcome === 'undetermined'
    ? { finding: { findingTypeId: 'CNS-03' as const, evidence: [screenshot] } }
    : {}),
});

const TAG = 'http://analytics.tracker.test/tag.js';
const COLLECT = 'http://analytics.tracker.test/collect?e=pageview';
const PIXEL = 'http://pixel.social.test/px.svg';
const CMP = 'http://consent.cmp.test/cmp.js';
const CDN = 'http://cdn.shop.test/style.css';
const FONT = 'http://fonts.example.test/inter.woff2';

const trackerRequests = () => [
  request(TAG),
  request(COLLECT, { chain: [TAG], initiator: { type: 'script', url: TAG } }),
  request(PIXEL),
];
const consented = (pass: 'B' | 'C', remembered = true): PassCapture['consent'] => ({
  action: pass === 'B' ? 'refuse' : 'accept',
  outcome: pass === 'B' ? 'refused' : 'accepted',
  platform: 'generic',
  steps: 3,
  recordedIn: { cookies: ['cmp_consent'], storage: ['local:cmp-choice'] },
  rememberedAfterReload: remembered,
});
const simpleRefusal = () =>
  refusal([
    step(1, 'found', 'generic banner'),
    step(2, 'click', 'Afvis alle'),
    step(3, 'hidden', 'banner gone'),
  ]);

describe('a site that ignores the refusal', () => {
  const result = diffPasses({
    a: capture('A', [request(CMP), ...trackerRequests()]),
    b: capture('B', [request(CMP), ...trackerRequests()], { consent: consented('B') }),
    c: capture('C', [request(CMP), ...trackerRequests()], { consent: consented('C') }),
    refusal: simpleRefusal(),
    identity,
  });

  it('judges each host by what it did', () => {
    expect(PassDiffSchema.safeParse(result.diff).success).toBe(true);
    const by = Object.fromEntries(result.diff.hosts.map((h) => [h.host, h]));
    expect(by['shop.test']?.role).toBe('first-party');
    expect(by['consent.cmp.test']?.role).toBe('consent-platform');
    expect(by['analytics.tracker.test']).toMatchObject({
      role: 'tracking',
      onFirstLoad: true,
      afterRefusal: true,
      afterAcceptance: true,
    });
    expect(by['analytics.tracker.test']?.signals).toContain('reports to /collect');
    expect(by['pixel.social.test']?.role).toBe('tracking');
    expect(by['pixel.social.test']?.signals.join(' ')).toMatch(/reports to \/px\.svg/);
  });

  it('raises CNS-01 and CNS-02 naming the hosts, with the diff as evidence', () => {
    expect(result.drafts.map((d) => d.typeId)).toEqual([
      CONSENT_FINDINGS.beforeInteraction,
      CONSENT_FINDINGS.refusalIgnored,
    ]);
    const cns02 = result.drafts[1]!;
    expect(cns02.hosts).toEqual(['analytics.tracker.test', 'pixel.social.test']);
    expect(cns02.summary).toMatch(/Refusing changed nothing for 2 tracking hosts/);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.kind).toBe('pass_diff');
    expect(result.evidence[0]!.caption).toBe(
      'Pass B (reject all) vs Pass C (accept all) — 2 hosts identical',
    );
    expect(cns02.evidence[0]!.evidenceId).toBe(result.evidence[0]!.id);
    expect(JSON.parse(result.evidence[0]!.body).ignoringRefusal).toEqual(cns02.hosts);
  });
});

describe('a site that behaves', () => {
  it('raises nothing when the trackers are gated behind acceptance and the refusal is one click', () => {
    const result = diffPasses({
      a: capture('A', [request(CMP), request(CDN)]),
      b: capture('B', [request(CMP), request(CDN)], { consent: consented('B') }),
      c: capture('C', [request(CMP), request(CDN), ...trackerRequests()], {
        consent: consented('C'),
      }),
      refusal: simpleRefusal(),
      identity,
    });
    expect(result.drafts).toEqual([]);
    expect(result.diff.gated).toEqual(['analytics.tracker.test', 'pixel.social.test']);
    expect(result.diff.beforeInteraction).toEqual([]);
  });

  it('raises nothing for a page with no third parties and no banner', () => {
    const noBanner = refusal([step(1, 'found', 'no banner')], 'no_banner');
    const result = diffPasses({
      a: capture('A', [request(CDN)]),
      b: capture('B', [request(CDN)], {
        consent: {
          ...consented('B'),
          outcome: 'no_banner',
          rememberedAfterReload: false,
          recordedIn: { cookies: [], storage: [] },
        },
      }),
      c: capture('C', [request(CDN)], {
        consent: {
          ...consented('C'),
          outcome: 'no_banner',
          rememberedAfterReload: false,
          recordedIn: { cookies: [], storage: [] },
        },
      }),
      refusal: noBanner,
      identity,
    });
    expect(result.drafts).toEqual([]);
    expect(result.diff.hosts.map((h) => [h.host, h.role])).toEqual([
      ['cdn.shop.test', 'first-party'],
      ['shop.test', 'first-party'],
    ]);
  });

  it('a third party that only serves a font is other, not tracking', () => {
    const font = request(FONT, { resourceType: 'font' });
    const result = diffPasses({
      a: capture('A', [font]),
      b: capture('B', [font], { consent: consented('B') }),
      c: capture('C', [font], { consent: consented('C') }),
      refusal: simpleRefusal(),
      identity,
    });
    expect(result.drafts).toEqual([]);
    expect(result.diff.hosts.find((h) => h.host === 'fonts.example.test')?.role).toBe('other');
  });
});

describe('the refusal path itself', () => {
  it('a tracker before interaction with no banner at all is CNS-01 only', () => {
    const noBanner = refusal([step(1, 'found', 'no banner')], 'no_banner');
    const result = diffPasses({
      a: capture('A', trackerRequests()),
      b: capture('B', trackerRequests(), {
        consent: { ...consented('B'), outcome: 'no_banner', rememberedAfterReload: false },
      }),
      c: capture('C', trackerRequests(), {
        consent: { ...consented('C'), outcome: 'no_banner', rememberedAfterReload: false },
      }),
      refusal: noBanner,
      identity,
    });
    expect(result.drafts.map((d) => d.typeId)).toEqual([CONSENT_FINDINGS.beforeInteraction]);
    expect(result.drafts[0]!.hosts).toEqual(['analytics.tracker.test', 'pixel.social.test']);
  });

  it('no refusal path is CNS-03; a forgotten refusal is CNS-04', () => {
    const undetermined = refusal([step(1, 'found', 'generic banner')], 'undetermined');
    const a = diffPasses({
      a: capture('A', []),
      b: capture('B', [], {
        consent: { ...consented('B'), outcome: 'undetermined', rememberedAfterReload: false },
      }),
      c: capture('C', [], { consent: consented('C') }),
      refusal: undetermined,
      identity,
      refusalEvidence: [screenshot],
    });
    expect(a.drafts.map((d) => d.typeId)).toEqual([CONSENT_FINDINGS.noRefusalPath]);
    expect(a.drafts[0]!.evidence).toHaveLength(2);

    const b = diffPasses({
      a: capture('A', []),
      b: capture('B', [], { consent: consented('B', false) }),
      c: capture('C', [], { consent: consented('C') }),
      refusal: simpleRefusal(),
      identity,
    });
    expect(b.drafts.map((d) => d.typeId)).toEqual([CONSENT_FINDINGS.choiceNotRemembered]);
  });

  it('refusing through settings with pre-ticked toggles is CNS-05, CNS-06 and CNS-07', () => {
    const buried = refusal([
      step(1, 'found', 'generic banner'),
      step(2, 'click', 'Indstillinger'),
      step(3, 'toggle_off', 'stat'),
      step(4, 'toggle_off', 'mkt'),
      step(5, 'toggle_off', 'pref'),
      step(6, 'save', 'Gem indstillinger'),
      step(7, 'hidden', 'banner gone'),
    ]);
    const result = diffPasses({
      a: capture('A', []),
      b: capture('B', [], { consent: consented('B') }),
      c: capture('C', [], { consent: consented('C') }),
      refusal: buried,
      identity,
      refusalEvidence: [screenshot],
    });
    expect(result.drafts.map((d) => d.typeId)).toEqual([
      CONSENT_FINDINGS.noRejectOnFirstLayer,
      CONSENT_FINDINGS.preTickedToggles,
      CONSENT_FINDINGS.refusalBuried,
    ]);
    expect(result.diff.refusal).toEqual({
      made: true,
      outcome: 'refused',
      interactions: 5,
      togglesOff: 3,
      layers: 1,
      remembered: true,
    });
    expect(result.drafts[0]!.summary).toMatch(/refusing took 5 interactions through the settings/);
    expect(result.drafts[1]!.summary).toMatch(/3 optional categories were switched on/);
    for (const d of result.drafts)
      expect(d.evidence.map((e) => e.evidenceId)).toContain(screenshot.evidenceId);
  });
});
