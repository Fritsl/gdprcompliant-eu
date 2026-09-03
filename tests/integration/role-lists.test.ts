import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@gc/contracts';
import {
  CHECK_FOR_ME_JOB,
  SHARED_TENANT,
  caseTimeline,
  createTestDatabase,
  grantFullAccess,
  inviteMember,
  joinByInvite,
  memberByInvite,
  memberView,
  openCase,
  requestCheck,
  schema,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { JobQueue } from '@gc/jobs';
import { loadCatalogue } from '@gc/remedies';

// Roles on a real case (P-01): an invited colleague reaches only their role's list by
// their token, nothing else on the case, until the owner grants the rest; and "check
// it for me" lands on the queue for the agent.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const T0 = new Date('2026-09-03T09:14:00Z');
const catalogue = loadCatalogue();
const remedy = (id: string) => {
  const entry = catalogue.get(id);
  if (!entry) throw new Error(`no remedy ${id}`);
  return { kind: entry.remedy.kind, title: entry.remedy.title.en ?? id };
};

const FINDINGS: { id: string; type: string; area: string; severity: string; remedy: string }[] = [
  {
    id: 'f-cns',
    type: 'CNS-02',
    area: 'Consent',
    severity: 'blocking',
    remedy: 'cns-02-gate-tags',
  },
  {
    id: 'f-frm',
    type: 'FRM-02',
    area: 'Collection',
    severity: 'advisory',
    remedy: 'frm-02-split-checkboxes',
  },
  {
    id: 'f-pol',
    type: 'POL-01',
    area: 'Notice',
    severity: 'serious',
    remedy: 'pol-01-write-privacy-policy',
  },
  { id: 'f-sec', type: 'SEC-03', area: 'Security', severity: 'serious', remedy: 'sec-03-hsts' },
  {
    id: 'f-rec',
    type: 'REC-01',
    area: 'Observation',
    severity: 'blocking',
    remedy: 'rec-01-mask-and-exclude-checkout',
  },
  {
    id: 'f-vnd',
    type: 'VND-06',
    area: 'Recipients',
    severity: 'advisory',
    remedy: 'vnd-06-self-host-fonts',
  },
  {
    id: 'f-trf',
    type: 'TRF-01',
    area: 'Transfers',
    severity: 'serious',
    remedy: 'trf-01-european-alternatives',
  },
  {
    id: 'f-dpa',
    type: 'DPA-01',
    area: 'Contracts',
    severity: 'serious',
    remedy: 'dpa-01-processing-agreement',
  },
];

describe.skipIf(!url)('roles and scoped lists (P-01)', () => {
  let t: TestDatabase;
  let caseId = '';
  let tenantId = '';
  let itToken = '';
  let itMemberId = '';

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => T0,
    });
    caseId = opened.caseId;
    tenantId = opened.tenantId;
    for (const f of FINDINGS) {
      const entry = catalogue.get(f.remedy)!;
      await t.db
        .insert(schema.remedies)
        .values({
          id: f.remedy,
          version: entry.remedy.version,
          tenantId: SHARED_TENANT,
          sourceRef: 'catalogue',
          findingTypeId: f.type,
          kind: entry.remedy.kind,
          jurisdictions: entry.remedy.jurisdictions,
          content: {},
          hash: sha256(f.remedy),
        })
        .onConflictDoNothing();
      await withTenant(t, tenantId, (db) =>
        db.insert(schema.findings).values({
          id: f.id,
          tenantId,
          sourceRef: 'test',
          caseId,
          typeId: f.type,
          fingerprint: `${f.type}|x`,
          jurisdiction: 'DK',
          binding: {},
          severity: f.severity,
          area: f.area,
          remedyId: f.remedy,
          remedyVersion: entry.remedy.version,
          firstSeenAt: T0,
          lastSeenAt: T0,
        }),
      );
    }
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('the owner invites a colleague into a role; the invitation is on the timeline', async () => {
    const invite = await inviteMember(t, {
      invitedBy: 'Mette',
      baseUrl: 'https://gdprcompliant.eu',
      caseId,
      tenantId,
      role: 'it',
      email: 'Lars@Eksempelbutik.dk',
      now: () => T0,
    });
    expect(invite.inviteToken).toMatch(/^[0-9a-f]{64}$/);
    itToken = invite.inviteToken;
    itMemberId = invite.memberId;
    await expect(
      inviteMember(t, {
        invitedBy: 'Mette',
        baseUrl: 'https://gdprcompliant.eu',
        caseId,
        tenantId,
        role: 'it',
        email: 'nobody',
        now: () => T0,
      }),
    ).rejects.toThrow(/not an address/);
    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    expect(events.at(-1)).toMatchObject({ type: 'colleague_invited', payload: { role: 'it' } });
  });

  it('the token resolves the member; a forged one resolves nothing; joining is on the timeline once', async () => {
    expect(await memberByInvite(t, itToken)).toMatchObject({
      role: 'it',
      caseId,
      tenantId,
      joined: false,
      grantedFull: false,
    });
    expect(await memberByInvite(t, 'f'.repeat(64))).toBeUndefined();
    expect(await memberByInvite(t, `${itToken}' or 1=1 --`)).toBeUndefined();
    expect(await joinByInvite(t, itToken, T0)).toMatchObject({ joined: true });
    expect(await joinByInvite(t, itToken, T0)).toMatchObject({ joined: true });
    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    expect(events.filter((e) => e.type === 'colleague_joined')).toHaveLength(1);
  });

  it('the member sees their role list and nothing else on the case', async () => {
    const view = await memberView(t, itToken, { locale: 'da', remedy });
    expect(view).toBeDefined();
    expect(view!.lists.map((l) => l.role)).toEqual(['it']);
    expect(view!.lists[0]!.items.map((i) => i.typeId)).toEqual(['REC-01', 'SEC-03', 'VND-06']);
    expect(view!.lists[0]!.items.length).toBeLessThan(6);
    expect(view!.visibleFindingIds.sort()).toEqual(['f-rec', 'f-sec', 'f-vnd']);
    expect(JSON.stringify(view)).not.toMatch(/CNS-02|FRM-02|POL-01|TRF-01|DPA-01/);
    expect(view!.lists[0]!.items[0]!.checkForMe.label).toBe('Det ved jeg ikke, tjek det for mig');
  });

  it('the owner grants the rest of the case, explicitly; then every list is visible', async () => {
    await expect(grantFullAccess(t, tenantId, caseId, 'member:nope')).rejects.toThrow(/no member/);
    await grantFullAccess(t, tenantId, caseId, itMemberId);
    const view = await memberView(t, itToken, { locale: 'en', remedy });
    expect(view!.member.grantedFull).toBe(true);
    expect(view!.lists.map((l) => [l.role, l.items.length])).toEqual([
      ['marketing', 3],
      ['it', 3],
      ['hr', 0],
      ['finance', 2],
    ]);
    expect(view!.visibleFindingIds).toHaveLength(FINDINGS.length);
  });

  it('"check it for me" lands on the queue for the agent, validated', async () => {
    const queue = new JobQueue({
      connectionString: url!,
      schema: `pgboss_${randomBytes(4).toString('hex')}`,
    });
    await queue.start();
    try {
      const view = await memberView(t, itToken, { locale: 'en', remedy });
      const item = view!.lists.find((l) => l.role === 'it')!.items[0]!;
      const id = await requestCheck(queue, item.checkForMe.proposal);
      expect((await queue.status(CHECK_FOR_ME_JOB, id))?.payload).toMatchObject({ type: 'crawl' });
      await expect(
        requestCheck(queue, { type: 'hack', payload: {}, rationale: 'x' } as never),
      ).rejects.toThrow();
    } finally {
      await queue.drop();
      await queue.stop({ graceful: false });
    }
  });
});
