import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Company } from '@gc/contracts';
import {
  ENTERPRISE_SYSTEMS,
  HUMAN_LANE_THRESHOLD,
  LANE_SIGNAL_IDS,
  laneInputFrom,
  scoreLane,
} from '@gc/db';
import { loadSectors } from '@gc/rules';

// Qualification and lane routing (L-01): the score comes from public facts, each signal
// says what it read, the result is stored and never shown to the customer, and no
// feature reads the lane. The customer's case is the same case in either lane.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const sectors = loadSectors();
const shop: Company = {
  domain: 'eksempelbutik.dk',
  country: 'DK',
  locale: 'da',
  sectorCode: '47.91.10',
  headcountBand: '10–49',
};

function files(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === '.next' || f === 'dist') continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}
const rel = (f: string) => relative(ROOT, f).split(sep).join('/');

describe('the signals', () => {
  it('are the seven the brief names, in its order, each with a reason', () => {
    const { signals } = scoreLane(
      laneInputFrom({
        company: shop,
        hosts: [],
        vendorHosts: [],
        vendorLabels: [],
        activities: ['orders'],
        categories: [],
        sectors,
      }),
    );
    expect(signals.map((s) => s.id)).toEqual([...LANE_SIGNAL_IDS]);
    expect(LANE_SIGNAL_IDS).toEqual([
      'headcount',
      'sector',
      'subdomains',
      'enterprise',
      'entities',
      'countries',
      'regulated',
    ]);
    for (const s of signals) {
      expect(s.because.length, s.id).toBeGreaterThan(10);
      expect(s.label.length, s.id).toBeGreaterThan(0);
      expect(s.points, s.id).toBeGreaterThanOrEqual(0);
    }
  });

  it('are read from public facts: the register band, the sector code, hosts seen, recipients', () => {
    const input = laneInputFrom({
      company: shop,
      hosts: [
        'eksempelbutik.dk',
        'www.eksempelbutik.dk',
        'shop.eksempelbutik.dk',
        'blog.eksempelbutik.dk',
        'eksempelbutik.de',
        'www.eksempelbutik.se',
        'www.googletagmanager.com',
        'cdn.salesforce.com',
      ],
      vendorHosts: ['hubspot'],
      vendorLabels: ['HubSpot, Inc.'],
      activities: ['orders'],
      categories: [],
      sectors,
    });
    expect(input).toMatchObject({
      headcountBand: '10–49',
      sector: 'online-retail',
      sectorLabel: 'online retail',
      regulated: false,
      subdomains: 3,
      enterpriseSystems: ['salesforce', 'hubspot'],
      entities: 1,
      countries: 3,
    });
  });

  it('a regulated sector and an unknown one are both said plainly', () => {
    const clinic = laneInputFrom({
      company: { ...shop, sectorCode: '86.21' },
      hosts: [],
      vendorHosts: [],
      vendorLabels: [],
      activities: [],
      categories: [],
      sectors,
    });
    expect(clinic).toMatchObject({ sector: 'healthcare', regulated: true });
    const bank = laneInputFrom({
      company: { ...shop, sectorCode: '64.19' },
      hosts: [],
      vendorHosts: [],
      vendorLabels: [],
      activities: [],
      categories: [],
      sectors,
    });
    expect(bank).toMatchObject({ sector: 'finance', regulated: true });
    const nothing = laneInputFrom({
      company: { domain: 'x.dk', country: 'DK', locale: 'da' },
      hosts: [],
      vendorHosts: [],
      vendorLabels: [],
      activities: [],
      categories: [],
      sectors,
    });
    expect(nothing).toMatchObject({
      sector: 'unknown',
      regulated: false,
      headcountBand: undefined,
    });
    const { signals } = scoreLane(nothing);
    expect(signals.find((s) => s.id === 'headcount')?.because).toContain('no headcount band');
    expect(signals.find((s) => s.id === 'sector')?.value).toBe('Unknown');
  });

  it('every enterprise system has an id and a pattern that matches something real', () => {
    for (const s of ENTERPRISE_SYSTEMS) {
      expect(s.id).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(s.pattern.test(s.example), s.id).toBe(true);
    }
  });
});

describe('the score', () => {
  const base = {
    sector: 'online-retail',
    sectorLabel: 'online retail',
    regulated: false,
    subdomains: 2,
    enterpriseSystems: [],
    entities: 1,
    countries: 1,
  };

  it('puts a small shop in the self-serve lane and says why on each line', () => {
    const r = scoreLane({ ...base, headcountBand: '10–49' });
    expect(r.lane).toBe('self-serve');
    expect(r.score).toBeLessThan(HUMAN_LANE_THRESHOLD);
    expect(r.signals.find((s) => s.id === 'enterprise')?.value).toBe('None detected');
    expect(r.signals.find((s) => s.id === 'regulated')?.value).toBe('No');
  });

  it('puts a large, regulated, multi-country company in the human lane', () => {
    const r = scoreLane({
      ...base,
      headcountBand: '250+',
      sector: 'finance',
      sectorLabel: 'finance and insurance',
      regulated: true,
      subdomains: 12,
      enterpriseSystems: ['salesforce', 'sap'],
      entities: 3,
      countries: 4,
    });
    expect(r.lane).toBe('human');
    expect(r.score).toBe(100);
    expect(r.signals.filter((s) => s.points > 0).length).toBeGreaterThanOrEqual(6);
  });

  it('is deterministic, bounded, and the sum of its signals', () => {
    for (const band of [undefined, '1–9', '10–49', '50–249', '250+']) {
      const a = scoreLane({ ...base, headcountBand: band });
      const b = scoreLane({ ...base, headcountBand: band });
      expect(a).toEqual(b);
      expect(a.score).toBe(
        Math.min(
          100,
          a.signals.reduce((n, s) => n + s.points, 0),
        ),
      );
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(100);
      expect(a.lane).toBe(a.score >= HUMAN_LANE_THRESHOLD ? 'human' : 'self-serve');
    }
  });

  it('one signal alone does not reach a person; it takes several', () => {
    expect(scoreLane({ ...base, headcountBand: '250+' }).lane).toBe('self-serve');
    expect(scoreLane({ ...base, enterpriseSystems: ['salesforce', 'sap'] }).lane).toBe(
      'self-serve',
    );
    expect(scoreLane({ ...base, headcountBand: '250+', regulated: true }).lane).toBe('human');
  });
});

describe('the lane is ours, not the customer’s', () => {
  it('no customer surface reads the lane, the score or the signals', () => {
    const web = files(join(ROOT, 'apps', 'web'));
    const offenders = web
      .filter((f) => /\blane(Score|Signals)?\b/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('the export leaves them out, and the summary never carried them', () => {
    const exp = readFileSync(join(ROOT, 'packages/db/src/export.ts'), 'utf8');
    expect(exp).toMatch(
      /omit\(all\.c, \[[^\]]*'lane'[^\]]*'laneScore'[^\]]*'laneSignals'[^\]]*\]\)/,
    );
    const declared = ['packages/contracts/src/case.ts', 'packages/db/src/export.ts']
      .map((f) => readFileSync(join(ROOT, f), 'utf8'))
      .map(
        (src) => /(?:interface|const) CaseSummary(?:Schema)?\b[^{]*\{([\s\S]*?)\n\}/.exec(src)?.[1],
      )
      .filter((m): m is string => typeof m === 'string');
    expect(declared.length).toBeGreaterThan(0);
    for (const body of declared) expect(body).not.toMatch(/\blane/i);
  });

  it('no feature is gated by lane: outside the scorer, nothing reads it', () => {
    const readers = [
      ...files(join(ROOT, 'packages', 'db', 'src')),
      ...files(join(ROOT, 'apps', 'worker', 'src')),
      ...files(join(ROOT, 'apps', 'web')),
      ...files(join(ROOT, 'packages', 'agent', 'src')),
      ...files(join(ROOT, 'packages', 'artefacts', 'src')),
    ]
      .filter((f) => !/[\\/]lane\.ts$/.test(f))
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        // A read: `.lane`, `lane ===`, `lane:` in a condition. Writing the default on
        // open, listing the column, and omitting it from the export are not reads.
        return (
          /\.lane\b(?!Score|Signals)\s*(===|!==|==|!=|\?(?!\?)|\))/.test(src) ||
          /\blane\s*(===|!==)\s*'/.test(src)
        );
      })
      .map(rel);
    expect(readers).toEqual([]);
  });
});
