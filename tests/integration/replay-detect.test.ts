import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EvidenceSchema,
  REPLAY_CHECKS,
  ReplayReportSchema,
  type ReplayObservation,
} from '@gc/contracts';
import { BrowserPool, FixtureServer, detectReplay, loadFixtureSites } from '@gc/scanner';

// Session replay and fingerprinting through a real Chromium (S-13): the clinic whose
// intake page is recorded and fingerprinted, and two sites where nothing of the kind
// happens.

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

const byCheck = (observations: readonly ReplayObservation[]) =>
  Object.fromEntries(observations.map((o) => [o.check, o])) as Record<
    keyof typeof REPLAY_CHECKS,
    ReplayObservation
  >;

describe('the clinic (S-13)', () => {
  it('sees the replay tool by host and by API, on the intake page with identity and health fields, unmasked', async () => {
    const { report, evidence } = await detectReplay(
      pool,
      { url: 'https://klinik.test/' },
      { identity, paths: ['/intake.html', '/om.html'] },
    );
    expect(ReplayReportSchema.parse(report)).toEqual(report);
    for (const e of evidence) expect(EvidenceSchema.parse(e)).toEqual(e);
    expect(
      report.pages.map((p) => [p.page, p.sensitivity, p.sensitiveFields, p.tools.map((t) => t.id)]),
    ).toEqual([
      ['/', 'none', [], ['hotjar']],
      ['/intake.html', 'special', ['cpr', 'symptomer'], ['hotjar']],
      ['/om.html', 'none', [], []],
    ]);
    const intake = report.pages[1]!;
    expect(intake.tools[0]).toEqual({
      id: 'hotjar',
      name: 'Hotjar',
      signals: ['network', 'api'],
      hosts: ['static.hotjar.com'],
      globals: ['hj', '_hjSettings'],
      masking: 'unknown',
      maskingDetail:
        'cpr, symptomer carry none of data-hj-suppress; a site-wide masking setting is not visible from the page',
    });

    const o = byCheck(report.observations);
    for (const check of Object.keys(REPLAY_CHECKS) as (keyof typeof REPLAY_CHECKS)[]) {
      expect(o[check].outcome, `${check}: ${o[check].summary}`).toBe('fail');
      expect(o[check].findingTypeId).toBe(REPLAY_CHECKS[check]);
      expect(o[check].evidence.length, check).toBeGreaterThan(0);
      for (const ref of o[check].evidence) {
        expect(evidence.find((e) => e.id === ref.evidenceId)?.hash).toBe(ref.hash);
      }
    }
    expect(o.replay_on_sensitive.severity).toBe('blocking');
    expect(o.replay_on_sensitive.detail['pages'] as { page: string; fields: string[] }[]).toEqual([
      expect.objectContaining({
        page: '/intake.html',
        tool: 'Hotjar',
        fields: ['cpr', 'symptomer'],
      }),
    ]);
  });

  it('reports canvas, font and audio probes separately, each naming the metrics script', async () => {
    const { report } = await detectReplay(pool, { url: 'https://klinik.test/' }, { identity });
    const o = byCheck(report.observations);
    for (const kind of ['canvas', 'font', 'audio'] as const) {
      expect(o[kind].outcome, kind).toBe('fail');
      expect(o[kind].detail['scripts'], kind).toEqual(['https://fp.metrics.test/fp.js']);
    }
    const probes = report.pages[0]!.probes;
    expect(probes.find((p) => p.kind === 'canvas')?.detail).toEqual({
      text: ['Cwm fjordbank glyphs vext quiz, 😃'],
    });
    expect(probes.find((p) => p.kind === 'font')?.detail).toMatchObject({ families: 30 });
    expect(probes.find((p) => p.kind === 'audio')?.detail).toEqual({
      nodes: expect.arrayContaining([
        'OscillatorNode',
        'DynamicsCompressorNode',
        'OfflineAudioContext',
      ]),
    });
    // The replay tool alone is not fingerprinting: it never touched the canvas.
    expect(o.canvas.detail['scripts']).not.toContain(
      'https://static.hotjar.com/c/hotjar-123.js?sv=6',
    );
  });
});

describe('sites without any of it (S-13)', () => {
  it('the clean brochure and the insecure shop pass all four checks', async () => {
    for (const url of ['https://brochure.test/', 'https://usikker.test/']) {
      const { report } = await detectReplay(pool, { url }, { identity });
      expect(
        report.observations.map((o) => [o.check, o.outcome]),
        url,
      ).toEqual([
        ['replay_on_sensitive', 'pass'],
        ['canvas', 'pass'],
        ['font', 'pass'],
        ['audio', 'pass'],
      ]);
      expect(report.pages[0]?.tools).toEqual([]);
    }
  });
});
