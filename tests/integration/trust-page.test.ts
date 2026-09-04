import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  caseTimeline,
  createTestDatabase,
  openCase,
  publishTrustPage,
  schema,
  seedRemedies,
  testDatabaseUrl,
  trustPage,
  trustStatus,
  unpublishTrustPage,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { bindingFor } from '@gc/findings';
import { loadCatalogue } from '@gc/remedies';

// The public progress page's data (U-05): off by default, published and taken down on
// the record, read by slug without a tenant, and handing out only what the page shows.

const url = testDatabaseUrl();
const T0 = new Date('2026-08-20T09:00:00Z');
const mette = { kind: 'person' as const, userId: 'u-mette', name: 'Mette' };

describe.skipIf(!url)('the public progress page data (U-05)', () => {
  let t: TestDatabase;
  let tenantId = '';
  let caseId = '';

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const catalogue = loadCatalogue();
    await seedRemedies(t, catalogue);
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
    });
    tenantId = opened.tenantId;
    caseId = opened.caseId;
    for (const [id, type, remedy, area, closed] of [
      ['f-1', 'SEC-03', 'sec-03-hsts', 'Security', true],
      ['f-2', 'CNS-02', 'cns-02-gate-tags', 'Consent', false],
    ] as const) {
      await withTenant(t, tenantId, (db) =>
        db.insert(schema.findings).values({
          id,
          tenantId,
          sourceRef: 'test',
          caseId,
          typeId: type,
          fingerprint: `${type}|x`,
          jurisdiction: 'DK',
          binding: bindingFor(type, 'DK'),
          severity: 'serious',
          status: closed ? 'closed' : 'open',
          area,
          remedyId: remedy,
          remedyVersion: catalogue.get(remedy)!.remedy.version,
          firstSeenAt: T0,
          lastSeenAt: T0,
          ...(closed ? { closedAt: T0 } : {}),
        }),
      );
    }
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('is off by default and unreadable until published', async () => {
    expect(await trustStatus(t, tenantId, caseId)).toEqual({ slug: null, publishedAt: null });
    expect(await trustPage(t, '0123456789abcdef')).toBeUndefined();
    expect(await trustPage(t, 'not-a-slug')).toBeUndefined();
  });

  it('publishes on the record, hands out fixed items and a count, and takes down on the record', async () => {
    const first = await publishTrustPage(t, tenantId, caseId, { by: mette, now: T0 });
    expect(first.already).toBe(false);
    expect(first.slug).toMatch(/^[a-f0-9]{16}$/);
    const again = await publishTrustPage(t, tenantId, caseId, { by: mette });
    expect(again).toEqual({ ...first, already: true });

    const view = await trustPage(t, first.slug);
    expect(view).toBeDefined();
    expect(view!.caseId).toBe(caseId);
    expect(view!.company.domain).toBe('eksempelbutik.dk');
    expect(view!.openCount).toBe(1);
    expect(view!.fixed).toEqual([
      {
        findingId: 'f-1',
        typeId: 'SEC-03',
        remedyId: 'sec-03-hsts',
        remedyVersion: loadCatalogue().get('sec-03-hsts')!.remedy.version,
        closedAt: T0,
      },
    ]);
    // No scan on the record yet: no date to show, and the view says so rather than
    // inventing one.
    expect(view!.lastCheckedAt).toBeNull();
    // What is open is not in the view at all, not even its id.
    expect(JSON.stringify(view)).not.toContain('f-2');
    expect(JSON.stringify(view)).not.toContain('CNS-02');

    expect(await unpublishTrustPage(t, tenantId, caseId, { by: mette })).toBe(true);
    expect(await unpublishTrustPage(t, tenantId, caseId, { by: mette })).toBe(false);
    expect(await trustPage(t, first.slug)).toBeUndefined();
    // The slug is kept, so a link a company already put on its site works again.
    expect((await trustStatus(t, tenantId, caseId)).slug).toBe(first.slug);
    const back = await publishTrustPage(t, tenantId, caseId, { by: mette });
    expect(back.slug).toBe(first.slug);

    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    expect(events.map((e) => e.type).filter((x) => x.startsWith('trust_'))).toEqual([
      'trust_published',
      'trust_unpublished',
      'trust_published',
    ]);
    for (const e of events.filter((x) => x.type.startsWith('trust_'))) {
      expect(e.actor).toEqual(mette);
      expect(e.payload).toEqual({ slug: first.slug });
    }
  });

  it('another tenant cannot publish, take down or see the slug', async () => {
    const other = await openCase(t, {
      company: { domain: 'anden.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
    });
    await expect(publishTrustPage(t, other.tenantId, caseId, { by: mette })).rejects.toThrow(
      /no case/,
    );
    expect(await unpublishTrustPage(t, other.tenantId, caseId, { by: mette })).toBe(false);
    expect(await trustStatus(t, other.tenantId, caseId)).toEqual({ slug: null, publishedAt: null });
  });
});
