import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256, type Evidence } from '@gc/contracts';
import {
  assignLane,
  caseSummary,
  createTestDatabase,
  exportCase,
  laneOf,
  openCase,
  storeEvidence,
  testDatabaseUrl,
  type TestDatabase,
} from '@gc/db';

// The lane on a real case (L-01): scored from what the case holds, stored with its
// signals, readable by an internal caller, and absent from everything the customer
// gets.

const url = testDatabaseUrl();
const T0 = new Date('2026-09-04T09:00:00Z');

const row = (ctx: { tenantId: string; caseId: string }, host: string, body: string): Evidence => {
  const hash = sha256(`${host}:${body}`);
  return {
    id: `header:${hash.slice(0, 16)}`,
    tenantId: ctx.tenantId,
    caseId: ctx.caseId,
    scanId: 'scan-l01',
    kind: 'header',
    capturedAt: T0.toISOString(),
    source: { url: `https://${host}/`, host, pass: 'A' },
    body: `${host}:${body}`,
    hash,
    caption: `Response headers of ${host}`,
  };
};

describe.skipIf(!url)('lane routing on a case (L-01)', () => {
  let t: TestDatabase;
  let ctx = { tenantId: '', caseId: '' };

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const opened = await openCase(t, {
      company: {
        domain: 'eksempelbutik.dk',
        country: 'DK',
        locale: 'da',
        sectorCode: '47.91.10',
        headcountBand: '50–249',
      },
      jurisdiction: 'DK',
      locale: 'da',
    });
    ctx = { tenantId: opened.tenantId, caseId: opened.caseId };
    await storeEvidence(t, ctx.tenantId, [
      row(ctx, 'eksempelbutik.dk', 'a'),
      row(ctx, 'www.eksempelbutik.dk', 'b'),
      row(ctx, 'shop.eksempelbutik.dk', 'c'),
      row(ctx, 'api.eksempelbutik.dk', 'd'),
      row(ctx, 'eksempelbutik.de', 'e'),
      row(ctx, 'cdn.salesforce.com', 'f'),
    ]);
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('opens in the self-serve lane with no score, and is scored from what it holds', async () => {
    expect(await laneOf(t, ctx.tenantId, ctx.caseId)).toEqual({
      lane: 'self-serve',
      score: 0,
      signals: [],
    });
    const result = await assignLane(t, ctx.tenantId, ctx.caseId);
    expect(result).toBeDefined();
    expect(result!.signals.map((s) => [s.id, s.value])).toEqual([
      ['headcount', '50–249'],
      ['sector', 'online retail'],
      ['subdomains', '3'],
      ['enterprise', 'salesforce'],
      ['entities', '1'],
      ['countries', '2'],
      ['regulated', 'No'],
    ]);
    expect(result!.lane).toBe('human');
    expect(await laneOf(t, ctx.tenantId, ctx.caseId)).toEqual(result);
  });

  it('is deterministic: scoring again stores the same thing', async () => {
    const again = await assignLane(t, ctx.tenantId, ctx.caseId);
    expect(again).toEqual(await laneOf(t, ctx.tenantId, ctx.caseId));
  });

  it('never reaches the customer: not in the summary, not in the export', async () => {
    const summary = await caseSummary(t, ctx.tenantId, ctx.caseId);
    expect(JSON.stringify(summary)).not.toMatch(/lane/i);
    const exported = await exportCase(t, ctx.tenantId, ctx.caseId, { locale: 'en', now: () => T0 });
    const bundle = JSON.parse(exported.json) as { case: Record<string, unknown> };
    expect(Object.keys(bundle.case)).not.toContain('lane');
    expect(Object.keys(bundle.case)).not.toContain('laneScore');
    expect(Object.keys(bundle.case)).not.toContain('laneSignals');
    expect(exported.json).not.toMatch(/"lane(Score|Signals)?"/);
    expect(exported.json).not.toContain('Enterprise systems');
    expect(exported.json).not.toContain('"because"');
  });
});
