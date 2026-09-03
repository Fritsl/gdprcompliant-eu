import { describe, expect, it } from 'vitest';
import {
  REPLAY_CHECKS,
  ReplayObservationSchema,
  SUPPORTED_JURISDICTIONS,
  type ReplayPage,
} from '@gc/contracts';
import { loadCatalogue } from '@gc/remedies';
import {
  FONT_PROBE_MIN_FAMILIES,
  REPLAY_VENDORS,
  evaluateReplay,
  maskingFor,
  probesFrom,
  recogniseTools,
} from '@gc/scanner';

// The replay and fingerprinting rules without a browser (S-13): who a host or a global
// points at, what the page can say about masking, when probe counts are a probe, and
// what the four checks make of it.

describe('recognising a replay tool', () => {
  it('by network host, by API surface, or both', () => {
    expect(recogniseTools({ hosts: ['static.hotjar.com', 'cdn.shop.dk'], globals: [] })).toEqual([
      {
        id: 'hotjar',
        name: 'Hotjar',
        signals: ['network'],
        hosts: ['static.hotjar.com'],
        globals: [],
      },
    ]);
    expect(recogniseTools({ hosts: [], globals: ['LogRocket'] })).toEqual([
      { id: 'logrocket', name: 'LogRocket', signals: ['api'], hosts: [], globals: ['LogRocket'] },
    ]);
    expect(
      recogniseTools({
        hosts: ['rs.fullstory.com', 'edge.fullstory.com'],
        globals: ['FS', 'hj'],
      }).map((t) => [t.id, t.signals]),
    ).toEqual([
      ['hotjar', ['api']],
      ['fullstory', ['network', 'api']],
    ]);
    expect(
      recogniseTools({ hosts: ['nothotjar.com', 'hotjar.com.evil.test'], globals: [] }),
    ).toEqual([]);
  });

  it('every vendor has at least one host pattern and one global', () => {
    for (const v of REPLAY_VENDORS) {
      expect(v.hosts.length, v.id).toBeGreaterThan(0);
      expect(v.globals.length, v.id).toBeGreaterThan(0);
    }
    expect(new Set(REPLAY_VENDORS.map((v) => v.id)).size).toBe(REPLAY_VENDORS.length);
  });
});

describe('what the page says about masking', () => {
  const hotjar = REPLAY_VENDORS.find((v) => v.id === 'hotjar')!;
  const crazy = { ...hotjar, id: 'x', name: 'X', maskAttributes: [], maskClasses: [] };

  it('is on only when every sensitive field carries a marker, and never off', () => {
    expect(
      maskingFor(hotjar, [
        { name: 'card', category: 'financial', markers: ['data-hj-suppress'] },
        { name: 'navn', category: 'contact', markers: [] },
      ]),
    ).toEqual({ masking: 'on', maskingDetail: 'every sensitive field carries data-hj-suppress' });
    expect(
      maskingFor(hotjar, [
        { name: 'card', category: 'financial', markers: [] },
        { name: 'cpr', category: 'identity', markers: ['data-hj-suppress'] },
      ]),
    ).toMatchObject({
      masking: 'unknown',
      maskingDetail: expect.stringMatching(/^card carry none of data-hj-suppress/),
    });
    expect(maskingFor(hotjar, [{ name: 'navn', category: 'contact', markers: [] }])).toMatchObject({
      masking: 'unknown',
      maskingDetail: 'no sensitive field on the page to look at',
    });
    expect(maskingFor(crazy, [{ name: 'card', category: 'financial', markers: [] }])).toMatchObject(
      {
        masking: 'unknown',
        maskingDetail: /no per-element masking marker/,
      },
    );
  });
});

describe('probe counts', () => {
  it('a canvas read is a probe; text measurement only across many families; audio when rendered', () => {
    const probes = probesFrom({
      canvas: { calls: 1, scripts: ['https://fp.test/fp.js'], text: ['Cwm fjord'] },
      font: {
        calls: 3,
        scripts: ['https://fp.test/fp.js'],
        fonts: ['72px Arial', '72px Verdana', '72px Arial'],
      },
      audio: { calls: 0, scripts: [], nodes: [] },
    });
    expect(probes.map((p) => [p.kind, p.calls])).toEqual([
      ['canvas', 1],
      ['font', 0],
      ['audio', 0],
    ]);
    expect(probes[1]?.detail).toEqual({ families: 2, measurements: 3 });
    const many = Array.from(
      { length: FONT_PROBE_MIN_FAMILIES },
      (_, i) => `72px "Font ${i}", monospace`,
    );
    expect(
      probesFrom({
        canvas: { calls: 0, scripts: [], text: [] },
        font: { calls: 10, scripts: [], fonts: many },
        audio: { calls: 2, scripts: [], nodes: ['OscillatorNode'] },
      }).map((p) => p.calls),
    ).toEqual([0, 10, 2]);
  });
});

const ev = (n: number) => ({
  evidenceId: `text:${n.toString(16).padStart(16, '0')}`,
  hash: 'b'.repeat(64),
});
const quiet = [
  { kind: 'canvas' as const, calls: 0, scripts: [], detail: {} },
  { kind: 'font' as const, calls: 0, scripts: [], detail: {} },
  { kind: 'audio' as const, calls: 0, scripts: [], detail: {} },
];
const page = (n: number, over: Partial<ReplayPage>): ReplayPage => ({
  page: `/p${n}`,
  sensitivity: 'contact',
  sensitiveFields: [],
  tools: [],
  probes: quiet,
  evidence: ev(n),
  ...over,
});
const hotjar = (masking: 'on' | 'unknown') => ({
  id: 'hotjar',
  name: 'Hotjar',
  signals: ['network' as const, 'api' as const],
  hosts: ['static.hotjar.com'],
  globals: ['hj'],
  masking,
  maskingDetail:
    masking === 'on'
      ? 'every sensitive field carries data-hj-suppress'
      : 'cpr carry none of data-hj-suppress',
});

describe('the checks over pages', () => {
  it('replay on a page with payment or identity fields fails unless masking is observably on', () => {
    const pages = [
      page(1, { tools: [hotjar('unknown')] }),
      page(2, { sensitivity: 'identity', sensitiveFields: ['cpr'], tools: [hotjar('unknown')] }),
      page(3, { sensitivity: 'financial', sensitiveFields: ['card'], tools: [hotjar('on')] }),
    ];
    const o = evaluateReplay(pages).find((x) => x.check === 'replay_on_sensitive')!;
    expect(o).toMatchObject({
      outcome: 'fail',
      findingTypeId: REPLAY_CHECKS.replay_on_sensitive,
      severity: 'serious',
    });
    expect(o.summary).toMatch(
      /Session replay is active on \/p2, where visitors type cpr: Hotjar on \/p2 \(masking unknown/,
    );
    expect(o.evidence).toEqual([ev(2)]);
    expect((o.detail['pages'] as { page: string }[]).map((p) => p.page)).toEqual(['/p2']);

    const blocking = evaluateReplay([
      page(4, {
        sensitivity: 'special',
        sensitiveFields: ['symptomer'],
        tools: [hotjar('unknown')],
      }),
    ]);
    expect(blocking[0]?.severity).toBe('blocking');
  });

  it('a tool seen only on harmless pages passes, and says so', () => {
    const o = evaluateReplay([page(1, { tools: [hotjar('unknown')] })]);
    expect(o[0]).toMatchObject({
      outcome: 'pass',
      summary: 'Hotjar seen, but not on a page with payment, account or health fields.',
    });
    expect(evaluateReplay([page(1, {})])[0]?.summary).toBe(
      'No session replay or heatmap tool was seen.',
    );
  });

  it('canvas, font and audio probes are reported separately, naming the script', () => {
    const pages = [
      page(1, {
        probes: [
          {
            kind: 'canvas',
            calls: 2,
            scripts: ['https://fp.test/fp.js'],
            detail: { text: ['Cwm'] },
          },
          {
            kind: 'font',
            calls: 30,
            scripts: ['https://fp.test/fp.js'],
            detail: { families: 30, measurements: 30 },
          },
          { kind: 'audio', calls: 0, scripts: [], detail: {} },
        ],
      }),
    ];
    const o = evaluateReplay(pages);
    expect(o.map((x) => [x.check, x.outcome, x.findingTypeId])).toEqual([
      ['replay_on_sensitive', 'pass', 'REC-01'],
      ['canvas', 'fail', 'FPR-01'],
      ['font', 'fail', 'FPR-02'],
      ['audio', 'pass', 'FPR-03'],
    ]);
    expect(o[1]?.summary).toBe('A script reads the canvas back on /p1: https://fp.test/fp.js.');
    expect(o[2]?.detail['scripts']).toEqual(['https://fp.test/fp.js']);
    expect(o[1]?.evidence).toEqual([ev(1)]);
  });

  it('an observation cannot fail without evidence, or map a check to the wrong finding', () => {
    const base = {
      check: 'canvas',
      findingTypeId: 'FPR-01',
      outcome: 'fail',
      severity: 'serious',
      summary: 'x',
    };
    expect(ReplayObservationSchema.safeParse(base).success).toBe(false);
    expect(ReplayObservationSchema.safeParse({ ...base, evidence: [ev(1)] }).success).toBe(true);
    expect(
      ReplayObservationSchema.safeParse({ ...base, findingTypeId: 'FPR-02', evidence: [ev(1)] })
        .success,
    ).toBe(false);
  });

  it('every check maps to a finding type with a remedy in every supported jurisdiction', () => {
    const catalogue = loadCatalogue();
    for (const [check, typeId] of Object.entries(REPLAY_CHECKS)) {
      for (const j of SUPPORTED_JURISDICTIONS) {
        expect(
          catalogue.forFinding(typeId, j).length,
          `${check} → ${typeId} in ${j}`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
