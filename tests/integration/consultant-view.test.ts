import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timelineModel } from '@gc/artefacts';
import { sha256, type Evidence } from '@gc/contracts';
import {
  assignLane,
  caseTimeline,
  createTestDatabase,
  exportCase,
  openAsConsultant,
  openCase,
  seedRemedies,
  storeEvidence,
  storeFindings,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { raiseFindings } from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';

// The consultant view (L-02): one of us opens the customer's case already briefed. The
// opening is on the timeline, where the customer reads it; the brief is generated from
// the case; and nothing else is written, because there is nowhere private to write.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const url = testDatabaseUrl();
const T0 = new Date('2026-09-04T09:00:00Z');
const catalogue = loadCatalogue();
const remedy = (id: string) => {
  const entry = catalogue.get(id);
  if (!entry) throw new Error(`no remedy ${id}`);
  return { kind: entry.remedy.kind, title: entry.remedy.title['en'] ?? id };
};

const row = (ctx: { tenantId: string; caseId: string }, host: string, body: string): Evidence => {
  const hash = sha256(`${host}:${body}`);
  return {
    id: `header:${hash.slice(0, 16)}`,
    tenantId: ctx.tenantId,
    caseId: ctx.caseId,
    scanId: 'scan-l02',
    kind: 'header',
    capturedAt: T0.toISOString(),
    source: { url: `https://${host}/`, host, pass: 'A' },
    body: `${host}:${body}`,
    hash,
    caption: `Response headers of ${host}`,
  };
};

describe.skipIf(!url)('the consultant view (L-02)', () => {
  let t: TestDatabase;
  let ctx = { tenantId: '', caseId: '' };
  const frits = { userId: 'frits', name: 'Frits Lyneborg' };

  beforeAll(async () => {
    t = await createTestDatabase(url);
    await seedRemedies(t, catalogue);
    const opened = await openCase(t, {
      company: {
        domain: 'klinikken.dk',
        legalName: 'Klinikken ApS',
        country: 'DK',
        locale: 'da',
        sectorCode: '86.21',
        headcountBand: '50–249',
      },
      jurisdiction: 'DK',
      locale: 'da',
    });
    ctx = { tenantId: opened.tenantId, caseId: opened.caseId };
    const hsts = row(ctx, 'www.klinikken.dk', 'no strict-transport-security');
    const sf = row(ctx, 'cdn.salesforce.com', 'x');
    await storeEvidence(t, ctx.tenantId, [hsts, sf, row(ctx, 'booking.klinikken.dk', 'y')]);
    const raised = raiseFindings(
      [
        { typeId: 'SEC-03', evidence: [{ evidenceId: hsts.id, hash: hsts.hash }] },
        {
          typeId: 'CNS-02',
          subject: { host: 'www.googletagmanager.com' },
          evidence: [{ evidenceId: sf.id, hash: sf.hash }],
        },
      ],
      { ...ctx, jurisdiction: 'DK', catalogue, scanId: 'scan-l02', now: () => T0 },
    );
    await storeFindings(t, ctx.tenantId, raised);
    await assignLane(t, ctx.tenantId, ctx.caseId);
  });

  afterAll(async () => {
    await t?.drop();
  });

  const events = () => withTenant(t, ctx.tenantId, (db) => caseTimeline(db, ctx.caseId));

  it('opens already briefed: headline, lane, signals with reasons, the queue row and a read', async () => {
    const brief = await openAsConsultant(t, ctx.tenantId, ctx.caseId, {
      by: frits,
      remedy,
      now: () => T0,
    });
    expect(brief).toBeDefined();
    expect(brief!.headline).toBe(`Klinikken ApS · ${ctx.caseId}`);
    // 50–249 staff, a regulated sector and an enterprise system: a person reaches out.
    expect(brief!.lane).toBe('human');
    expect(brief!.signals.map((s) => [s.label, s.value, s.level])).toEqual([
      ['Headcount band', '50–249', 'high'],
      ['Sector', 'health and care', 'low'],
      ['Subdomains', '2', 'low'],
      ['Enterprise systems', 'salesforce', 'high'],
      ['Entities', '1', 'low'],
      ['Countries', '1', 'low'],
      ['Regulated sector', 'Yes', 'high'],
    ]);
    for (const s of brief!.signals) expect(s.because.length).toBeGreaterThan(10);
    expect(brief!.queue.open).toBe(2);
    expect(brief!.queue.hook?.typeId).toBe('CNS-02');
    expect(brief!.queue.why).toHaveLength(3);
    expect(brief!.read).toMatch(
      /^Budget signals: headcount band 50–249, enterprise systems salesforce, regulated sector Yes\./,
    );
    expect(brief!.read).toContain('Open with CNS-02:');
    expect(brief!.visible).toBe(
      "This case has been opened by Frits Lyneborg once. Every opening is on the customer's timeline.",
    );
    expect(brief!.opened).toBe(1);
  });

  it('every opening is on the timeline as a named person, in the customer’s language', async () => {
    const again = await openAsConsultant(t, ctx.tenantId, ctx.caseId, {
      by: frits,
      remedy,
      now: () => new Date(T0.getTime() + 60_000),
    });
    expect(again!.visible).toMatch(/^This case has been opened by Frits Lyneborg twice\./);
    const other = await openAsConsultant(t, ctx.tenantId, ctx.caseId, {
      by: { userId: 'mette', name: 'Mette Sørensen' },
      remedy,
      now: () => new Date(T0.getTime() + 120_000),
    });
    expect(other!.visible).toBe(
      "This case has been opened by Mette Sørensen once, and 3 times in all. Every opening is on the customer's timeline.",
    );
    const opened = (await events()).filter((e) => e.type === 'internal_access');
    expect(opened).toHaveLength(3);
    expect(opened.map((e) => e.actor)).toEqual([
      { kind: 'person', userId: 'staff:frits', name: 'Frits Lyneborg' },
      { kind: 'person', userId: 'staff:frits', name: 'Frits Lyneborg' },
      { kind: 'person', userId: 'staff:mette', name: 'Mette Sørensen' },
    ]);
    const model = timelineModel(ctx.caseId, await events(), { locale: 'da' });
    const shown = model.entries.filter((e) => e.type === 'internal_access');
    expect(shown.map((e) => e.text)).toEqual(Array(3).fill('Åbnet af en konsulent'));
    expect(shown[2]!.detail).toBe('Mette Sørensen');
    expect(shown.every((e) => !e.fellBack)).toBe(true);
  });

  it('writes nothing but the opening: the export differs by one event and nothing else', async () => {
    const before = JSON.parse(
      (await exportCase(t, ctx.tenantId, ctx.caseId, { locale: 'en', now: () => T0 })).json,
    ) as { timeline: unknown[]; [k: string]: unknown };
    await openAsConsultant(t, ctx.tenantId, ctx.caseId, {
      by: frits,
      remedy,
      now: () => new Date(T0.getTime() + 180_000),
    });
    const after = JSON.parse(
      (await exportCase(t, ctx.tenantId, ctx.caseId, { locale: 'en', now: () => T0 })).json,
    ) as { timeline: unknown[]; [k: string]: unknown };
    // Exporting is itself an event, so two land: the export, and the opening.
    expect(after.timeline.length).toBe(before.timeline.length + 2);
    const types = (b: { timeline: unknown[] }) =>
      (b.timeline as { type: string }[]).map((e) => e.type);
    expect(types(after).slice(types(before).length)).toEqual([
      'export_produced',
      'internal_access',
    ]);
    const strip = (b: { [k: string]: unknown }) => {
      const rest = { ...b };
      delete rest['timeline'];
      delete rest['documents'];
      delete rest['exportedAt'];
      return rest;
    };
    expect(strip(after)).toEqual(strip(before));
    // The brief is not stored, and no customer-visible table has a column for a private note.
    const schema = readFileSync(join(ROOT, 'packages/db/src/schema.ts'), 'utf8');
    expect(schema).not.toMatch(/internalNote|consultantNote|annotation|privateNote|brief/i);
    expect(JSON.stringify(after)).not.toMatch(/Budget signals|do not assign/);
  });
});
