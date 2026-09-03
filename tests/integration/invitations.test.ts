import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INVITES_PER_CASE_PER_HOUR,
  RateLimited,
  caseTimeline,
  createTestDatabase,
  inviteMember,
  joinByInvite,
  listMembers,
  memberByInvite,
  openCase,
  outboxFor,
  remindMember,
  revokeInvitation,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';

// Invitations from a colleague (P-02) at the service layer: in the inviter's name,
// landing on the outbox with a single-purpose link that expires and can be withdrawn;
// every step on the timeline; and the rate limits that keep the feature from being a
// mailer for strangers.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const T0 = new Date('2026-09-04T09:14:00Z');
const at = (hours: number) => () => new Date(T0.getTime() + hours * 3_600_000);
const BASE = 'https://gdprcompliant.eu';

describe.skipIf(!url)('invitations (P-02)', () => {
  let t: TestDatabase;
  let caseId = '';
  let tenantId = '';

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: at(0),
    });
    caseId = opened.caseId;
    tenantId = opened.tenantId;
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('comes from the person, in their name, and lands on the outbox with a link that expires', async () => {
    const invite = await inviteMember(t, {
      caseId,
      tenantId,
      role: 'it',
      email: 'Lars@Eksempelbutik.dk',
      invitedBy: 'Mette',
      baseUrl: BASE,
      locale: 'da',
      now: at(0),
    });
    expect(invite.link).toBe(`${BASE}/da/m/${invite.inviteToken}`);
    expect(invite.expiresAt.toISOString()).toBe(at(14 * 24)().toISOString());
    const mail = await outboxFor(t, tenantId, caseId);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      kind: 'invitation',
      to: 'lars@eksempelbutik.dk',
      subject: `Mette · ${caseId}`,
    });
    expect(mail[0]?.body).toContain(invite.link);
    expect(mail[0]?.body).toContain('Mette');
    expect(await memberByInvite(t, invite.inviteToken)).toMatchObject({
      invitedBy: 'Mette',
      joined: false,
    });
    await expect(
      inviteMember(t, {
        caseId,
        tenantId,
        role: 'it',
        email: 'x@eksempelbutik.dk',
        invitedBy: '  ',
        baseUrl: BASE,
      }),
    ).rejects.toThrow(/name the inviter/);
  });

  it('opening the link joins, once, and shows up on the colleagues list; a reminder goes out at most daily', async () => {
    const [first] = await listMembers(t, tenantId, caseId, {
      baseUrl: BASE,
      locale: 'da',
      now: at(1),
    });
    expect(first).toMatchObject({
      role: 'it',
      email: 'lars@eksempelbutik.dk',
      invitedBy: 'Mette',
      status: 'invited',
      open: 0,
    });
    expect(first?.link).toMatch(/\/da\/m\/[0-9a-f]{64}$/);
    const token = first!.link!.split('/').pop()!;
    expect(await joinByInvite(t, token, at(2)())).toMatchObject({ joined: true });
    expect(await joinByInvite(t, token, at(3)())).toMatchObject({ joined: true });
    const [joined] = await listMembers(t, tenantId, caseId, { baseUrl: BASE, now: at(3) });
    // No open items for IT on this case, so joining is already finishing.
    expect(joined?.status).toBe('finished');

    await remindMember(
      t,
      { tenantId, caseId, memberId: first!.memberId },
      { baseUrl: BASE, locale: 'da', now: at(4) },
    );
    await expect(
      remindMember(
        t,
        { tenantId, caseId, memberId: first!.memberId },
        { baseUrl: BASE, now: at(5) },
      ),
    ).rejects.toThrow(RateLimited);
    await remindMember(
      t,
      { tenantId, caseId, memberId: first!.memberId },
      { baseUrl: BASE, now: at(29) },
    );
    const mail = await outboxFor(t, tenantId, caseId);
    expect(mail.map((m) => m.kind)).toEqual(['invitation', 'reminder', 'reminder']);

    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    expect(events.map((e) => e.type)).toEqual([
      'case_opened',
      'colleague_invited',
      'colleague_joined',
      'reminder_sent',
      'reminder_sent',
    ]);
  });

  it('a withdrawn link is dead, and so is an expired one; both are on the timeline as facts', async () => {
    const invite = await inviteMember(t, {
      caseId,
      tenantId,
      role: 'hr',
      email: 'hr@eksempelbutik.dk',
      invitedBy: 'Mette',
      baseUrl: BASE,
      now: at(6),
    });
    expect(await memberByInvite(t, invite.inviteToken)).toBeDefined();
    await revokeInvitation(t, { tenantId, caseId, memberId: invite.memberId }, at(7)());
    await revokeInvitation(t, { tenantId, caseId, memberId: invite.memberId }, at(8)());
    expect(await memberByInvite(t, invite.inviteToken)).toBeUndefined();
    expect(await joinByInvite(t, invite.inviteToken)).toBeUndefined();
    await expect(
      remindMember(
        t,
        { tenantId, caseId, memberId: invite.memberId },
        { baseUrl: BASE, now: at(9) },
      ),
    ).rejects.toThrow(/revoked/);

    const short = await inviteMember(t, {
      caseId,
      tenantId,
      role: 'finance',
      email: 'fin@eksempelbutik.dk',
      invitedBy: 'Mette',
      baseUrl: BASE,
      now: at(0),
      ttlDays: 1,
    });
    await t.sql`update case_members set expires_at = now() - interval '1 minute' where id = ${short.memberId}`;
    expect(await memberByInvite(t, short.inviteToken)).toBeUndefined();

    const members = await listMembers(t, tenantId, caseId, {
      baseUrl: BASE,
      now: () => new Date(),
    });
    expect(members.map((m) => [m.role, m.status, m.link !== undefined])).toEqual([
      ['it', 'finished', true],
      // Invited with an earlier clock than hr, so it lists first.
      ['finance', 'expired', false],
      ['hr', 'revoked', false],
    ]);
    const events = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    expect(events.filter((e) => e.type === 'invitation_revoked')).toHaveLength(1);
  });

  it('is rate-limited per case per hour, and says when to try again', async () => {
    const sent = (await outboxFor(t, tenantId, caseId)).filter(
      (m) => m.kind === 'invitation',
    ).length;
    for (let i = sent; i < INVITES_PER_CASE_PER_HOUR; i += 1) {
      await inviteMember(t, {
        caseId,
        tenantId,
        role: 'marketing',
        email: `m${i}@eksempelbutik.dk`,
        invitedBy: 'Mette',
        baseUrl: BASE,
        now: at(0.5),
      });
    }
    await expect(
      inviteMember(t, {
        caseId,
        tenantId,
        role: 'marketing',
        email: 'late@eksempelbutik.dk',
        invitedBy: 'Mette',
        baseUrl: BASE,
        now: at(0.75),
      }),
    ).rejects.toMatchObject({ name: 'RateLimited', what: 'invitations' });
    // An hour after the oldest, the window has moved on.
    await inviteMember(t, {
      caseId,
      tenantId,
      role: 'marketing',
      email: 'later@eksempelbutik.dk',
      invitedBy: 'Mette',
      baseUrl: BASE,
      now: at(30),
    });
  });
});
