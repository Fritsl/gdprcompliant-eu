import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  caseTimeline,
  createShare,
  createTestDatabase,
  listShares,
  openCase,
  revokeShare,
  shareByToken,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';

// Upward share links (U-07): each its own token, on the record when created and when
// revoked, dead the moment it is revoked or expired, and never another tenant's to touch.

const url = testDatabaseUrl();
const mette = { kind: 'person' as const, userId: 'u-mette', name: 'Mette' };
const BASE = 'https://app.test';

describe.skipIf(!url)('upward share links (U-07)', () => {
  let t: TestDatabase;
  let tenantId = '';
  let caseId = '';

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
    });
    tenantId = opened.tenantId;
    caseId = opened.caseId;
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('creates a live link on the record, resolves it without a tenant, and revokes it on the record', async () => {
    const created = await createShare(t, tenantId, caseId, { audience: 'The board', by: mette });
    expect(created.token).toMatch(/^[0-9a-f]{64}$/);
    expect(created.audience).toBe('The board');
    const live = await shareByToken(t, created.token);
    expect(live).toEqual({
      shareId: created.shareId,
      caseId,
      tenantId,
      kind: 'upward',
      audience: 'The board',
    });
    const listed = await listShares(t, tenantId, caseId, { baseUrl: BASE, locale: 'en' });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe('live');
    expect(listed[0]!.link).toBe(`${BASE}/en/s/${created.token}`);
    expect(listed[0]!.createdBy).toBe('Mette');

    expect(await revokeShare(t, tenantId, caseId, created.shareId, { by: mette })).toBe(true);
    expect(await revokeShare(t, tenantId, caseId, created.shareId, { by: mette })).toBe(false);
    expect(await shareByToken(t, created.token)).toBeUndefined();
    const after = await listShares(t, tenantId, caseId, { baseUrl: BASE, locale: 'en' });
    expect(after[0]!.status).toBe('revoked');
    expect(after[0]!.link).toBeUndefined();

    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    const mine = events.filter((e) => e.type === 'share_created' || e.type === 'share_revoked');
    expect(mine.map((e) => e.type)).toEqual(['share_created', 'share_revoked']);
    expect(mine[0]!.payload).toEqual({
      shareId: created.shareId,
      kind: 'upward',
      audience: 'The board',
    });
    expect(mine[1]!.payload).toEqual({ shareId: created.shareId, kind: 'upward' });
    for (const e of mine) expect(e.actor).toEqual(mette);
  });

  it('an expired link answers nothing, and says expired to its holder', async () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    const created = await createShare(t, tenantId, caseId, {
      audience: 'Last quarter',
      by: mette,
      now: old,
    });
    expect(await shareByToken(t, created.token)).toBeUndefined();
    const listed = await listShares(t, tenantId, caseId, { baseUrl: BASE, locale: 'en' });
    const row = listed.find((s) => s.shareId === created.shareId)!;
    expect(row.status).toBe('expired');
    expect(row.link).toBeUndefined();
  });

  it('a wrong or malformed token answers nothing; another tenant cannot revoke', async () => {
    const created = await createShare(t, tenantId, caseId, { audience: 'Auditor', by: mette });
    expect(await shareByToken(t, 'a'.repeat(64))).toBeUndefined();
    expect(await shareByToken(t, 'not a token')).toBeUndefined();
    const other = await openCase(t, {
      company: { domain: 'anden.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
    });
    expect(await revokeShare(t, other.tenantId, caseId, created.shareId, { by: mette })).toBe(
      false,
    );
    expect(await listShares(t, other.tenantId, caseId, { baseUrl: BASE, locale: 'en' })).toEqual(
      [],
    );
    expect(await shareByToken(t, created.token)).toBeDefined();
  });
});
