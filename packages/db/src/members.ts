import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { TaskProposalSchema, type Locale, type RemedyKind, type TaskProposal } from '@gc/contracts';
import {
  assembleRoleLists,
  roleFor,
  type Role,
  type RoleFinding,
  type RoleList,
} from '@gc/findings';
import { defineJob, type JobQueue } from '@gc/jobs';
import type { Connection, Db } from './client.js';
import { caseMembers, cases, findings, mailOutbox } from './schema.js';
import { withTenant } from './tenant.js';
import { appendCaseEvent } from './timeline.js';

// Colleagues on a case (P-01, P-02): invited by a person, in that person's name, into a
// role; reaching their list by an invitation link that is single-purpose, expiring and
// revocable; seeing only that role's items until the owner grants the rest. Every
// invitation, reminder, revocation and acceptance is on the timeline. Mail goes to an
// outbox, and the outbox is what rate-limits the feature.

export const INVITE_TTL_DAYS = 14;
export const INVITES_PER_CASE_PER_HOUR = 10;
export const REMINDER_GAP_HOURS = 24;

export class RateLimited extends Error {
  constructor(
    readonly what: 'invitations' | 'reminders',
    readonly retryAfterMs: number,
  ) {
    super(`too many ${what}; try again in ${Math.ceil(retryAfterMs / 60_000)} minute(s)`);
    this.name = 'RateLimited';
  }
}

export interface InviteInput {
  readonly caseId: string;
  readonly tenantId: string;
  readonly role: Role;
  readonly email: string;
  // Who is asking, in their own words: "Mette", "Mette (Marketing)".
  readonly invitedBy: string;
  // Where the link points: the app's origin, e.g. https://gdprcompliant.eu.
  readonly baseUrl: string;
  readonly locale?: Locale;
  readonly now?: () => Date;
  readonly ttlDays?: number;
}

export interface Invitation {
  readonly memberId: string;
  readonly inviteToken: string;
  readonly role: Role;
  readonly link: string;
  readonly expiresAt: Date;
}

const newToken = () => randomBytes(32).toString('hex');
const hours = (n: number) => n * 3_600_000;

export const inviteLink = (baseUrl: string, locale: Locale, token: string): string =>
  `${baseUrl.replace(/\/$/, '')}/${locale}/m/${token}`;

async function queueMail(
  db: Db,
  tenantId: string,
  caseId: string,
  kind: 'invitation' | 'reminder',
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  await db.insert(mailOutbox).values({
    id: `mail:${randomBytes(12).toString('hex')}`,
    tenantId,
    sourceRef: `case:${caseId}`,
    caseId,
    kind,
    to,
    subject,
    body,
  });
}

export async function inviteMember(
  connection: Connection,
  input: InviteInput,
): Promise<Invitation> {
  const now = (input.now ?? (() => new Date()))();
  const email = input.email.trim().toLowerCase();
  const invitedBy = input.invitedBy.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error(`not an address: ${input.email}`);
  if (!invitedBy) throw new Error('an invitation comes from someone: name the inviter');
  const locale = input.locale ?? 'en';
  return withTenant(connection, input.tenantId, async (db) => {
    const [c] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(eq(cases.id, input.caseId))
      .limit(1);
    if (!c) throw new Error(`no case ${input.caseId}`);

    // Ten invitations an hour per case is more than any team needs and far less than a
    // mailer needs. Every invitation counts, withdrawn ones included.
    const recent = await db
      .select({ invitedAt: caseMembers.invitedAt })
      .from(caseMembers)
      .where(
        and(
          eq(caseMembers.caseId, input.caseId),
          gt(caseMembers.invitedAt, new Date(now.getTime() - hours(1))),
        ),
      )
      .orderBy(desc(caseMembers.invitedAt));
    if (recent.length >= INVITES_PER_CASE_PER_HOUR) {
      const oldest = recent[recent.length - 1]!.invitedAt;
      throw new RateLimited('invitations', oldest.getTime() + hours(1) - now.getTime());
    }

    const inviteToken = newToken();
    const memberId = `member:${inviteToken.slice(0, 16)}`;
    const expiresAt = new Date(now.getTime() + (input.ttlDays ?? INVITE_TTL_DAYS) * 86_400_000);
    await db.insert(caseMembers).values({
      id: memberId,
      tenantId: input.tenantId,
      sourceRef: `case:${input.caseId}`,
      caseId: input.caseId,
      role: input.role,
      email,
      inviteToken,
      invitedAt: now,
      invitedBy,
      expiresAt,
    });
    const link = inviteLink(input.baseUrl, locale, inviteToken);
    await queueMail(
      db,
      input.tenantId,
      input.caseId,
      'invitation',
      email,
      `${invitedBy} · ${input.caseId}`,
      `${invitedBy} has a few things for you on ${input.caseId}.\n\n${link}\n\nThe link is yours alone and stops working on ${expiresAt.toISOString().slice(0, 10)}.`,
    );
    await appendCaseEvent(db, {
      tenantId: input.tenantId,
      caseId: input.caseId,
      at: now,
      // In the inviter's name (P-02, U-07): the record says who asked, not the machine.
      actor: { kind: 'person', userId: `inviter:${input.caseId}`, name: invitedBy },
      type: 'colleague_invited',
      payload: { role: input.role },
    });
    return { memberId, inviteToken, role: input.role, link, expiresAt };
  });
}

export interface MemberByInvite {
  readonly memberId: string;
  readonly caseId: string;
  readonly tenantId: string;
  readonly role: Role;
  readonly invitedBy: string;
  readonly joined: boolean;
  readonly grantedFull: boolean;
}

// The link is the only way to a member's list. A definer function resolves it, since
// the holder has no tenant context yet; an expired or revoked invitation is not found.
export async function memberByInvite(
  connection: Pick<Connection, 'sql'>,
  token: string,
): Promise<MemberByInvite | undefined> {
  if (!/^[0-9a-f]{32,128}$/.test(token)) return undefined;
  const [row] = await connection.sql<
    {
      member_id: string;
      case_id: string;
      tenant_id: string;
      role: Role;
      invited_by: string;
      joined_at: string | null;
      granted_full: boolean;
    }[]
  >`select * from member_by_invite(${token})`;
  if (!row) return undefined;
  return {
    memberId: row.member_id,
    caseId: row.case_id,
    tenantId: row.tenant_id,
    role: row.role,
    invitedBy: row.invited_by,
    joined: row.joined_at !== null,
    grantedFull: row.granted_full,
  };
}

// First visit: the invitation becomes a membership, on the timeline. No account, no
// form: the list is the next thing they see.
export async function joinByInvite(
  connection: Connection,
  token: string,
  now: Date = new Date(),
): Promise<MemberByInvite | undefined> {
  const member = await memberByInvite(connection, token);
  if (!member) return undefined;
  if (member.joined) return member;
  await withTenant(connection, member.tenantId, async (db) => {
    await db.update(caseMembers).set({ joinedAt: now }).where(eq(caseMembers.id, member.memberId));
    await appendCaseEvent(db, {
      tenantId: member.tenantId,
      caseId: member.caseId,
      at: now,
      actor: { kind: 'system' },
      type: 'colleague_joined',
      payload: { role: member.role },
    });
  });
  return { ...member, joined: true };
}

interface MemberRef {
  readonly tenantId: string;
  readonly caseId: string;
  readonly memberId: string;
}

async function memberRow(db: Db, ref: MemberRef) {
  const [m] = await db
    .select()
    .from(caseMembers)
    .where(and(eq(caseMembers.id, ref.memberId), eq(caseMembers.caseId, ref.caseId)))
    .limit(1);
  if (!m) throw new Error(`no member ${ref.memberId} on ${ref.caseId}`);
  return m;
}

// A nudge, at most once a day per colleague, on the timeline.
export async function remindMember(
  connection: Connection,
  ref: MemberRef,
  options: { readonly baseUrl: string; readonly locale?: Locale; readonly now?: () => Date },
): Promise<{ link: string }> {
  const now = (options.now ?? (() => new Date()))();
  return withTenant(connection, ref.tenantId, async (db) => {
    const m = await memberRow(db, ref);
    if (m.revokedAt) throw new Error(`invitation ${ref.memberId} was revoked`);
    if (m.remindedAt && m.remindedAt.getTime() + hours(REMINDER_GAP_HOURS) > now.getTime()) {
      throw new RateLimited(
        'reminders',
        m.remindedAt.getTime() + hours(REMINDER_GAP_HOURS) - now.getTime(),
      );
    }
    const link = inviteLink(options.baseUrl, options.locale ?? 'en', m.inviteToken);
    await queueMail(
      db,
      ref.tenantId,
      ref.caseId,
      'reminder',
      m.email,
      `${m.invitedBy} · ${ref.caseId}`,
      `${m.invitedBy} is still waiting on a few things on ${ref.caseId}.\n\n${link}`,
    );
    await db.update(caseMembers).set({ remindedAt: now }).where(eq(caseMembers.id, m.id));
    await appendCaseEvent(db, {
      tenantId: ref.tenantId,
      caseId: ref.caseId,
      at: now,
      actor: { kind: 'system' },
      type: 'reminder_sent',
      payload: { role: m.role },
    });
    return { link };
  });
}

// The owner withdraws an invitation: the link is dead from now on.
export async function revokeInvitation(
  connection: Connection,
  ref: MemberRef,
  now: Date = new Date(),
): Promise<void> {
  await withTenant(connection, ref.tenantId, async (db) => {
    const m = await memberRow(db, ref);
    if (m.revokedAt) return;
    await db.update(caseMembers).set({ revokedAt: now }).where(eq(caseMembers.id, m.id));
    await appendCaseEvent(db, {
      tenantId: ref.tenantId,
      caseId: ref.caseId,
      at: now,
      actor: { kind: 'system' },
      type: 'invitation_revoked',
      payload: { role: m.role },
    });
  });
}

// The owner opens the rest of the case to a member. Explicit, never implied.
export async function grantFullAccess(
  connection: Connection,
  tenantId: string,
  caseId: string,
  memberId: string,
): Promise<void> {
  await withTenant(connection, tenantId, async (db) => {
    const updated = await db
      .update(caseMembers)
      .set({ grantedFull: true })
      .where(and(eq(caseMembers.id, memberId), eq(caseMembers.caseId, caseId)))
      .returning({ id: caseMembers.id });
    if (updated.length !== 1) throw new Error(`no member ${memberId} on ${caseId}`);
  });
}

export type MemberStatus = 'invited' | 'joined' | 'finished' | 'revoked' | 'expired';

export interface MemberSummary {
  readonly memberId: string;
  readonly role: Role;
  readonly email: string;
  readonly invitedBy: string;
  readonly invitedAt: Date;
  readonly expiresAt: Date;
  readonly remindedAt: Date | null;
  readonly status: MemberStatus;
  // Open items on their role's list, so the owner sees who has not finished.
  readonly open: number;
  // For the owner to send by hand if mail does not arrive. Absent once dead.
  readonly link?: string;
}

// The colleagues screen (P-02): who has not finished, with what the owner can do.
export async function listMembers(
  connection: Connection,
  tenantId: string,
  caseId: string,
  options: { readonly baseUrl: string; readonly locale?: Locale; readonly now?: () => Date },
): Promise<MemberSummary[]> {
  const now = (options.now ?? (() => new Date()))();
  return withTenant(connection, tenantId, async (db) => {
    const rows = await db
      .select()
      .from(caseMembers)
      .where(eq(caseMembers.caseId, caseId))
      .orderBy(caseMembers.invitedAt);
    const open = await db
      .select({ typeId: findings.typeId, area: findings.area, status: findings.status })
      .from(findings)
      .where(and(eq(findings.caseId, caseId)));
    const openByRole = new Map<Role, number>();
    for (const f of open) {
      if (f.status === 'closed') continue;
      const role = roleFor({ typeId: f.typeId, area: f.area as RoleFinding['area'] });
      openByRole.set(role, (openByRole.get(role) ?? 0) + 1);
    }
    return rows.map((m) => {
      const openCount = openByRole.get(m.role as Role) ?? 0;
      const status: MemberStatus = m.revokedAt
        ? 'revoked'
        : m.joinedAt
          ? openCount === 0
            ? 'finished'
            : 'joined'
          : m.expiresAt.getTime() <= now.getTime()
            ? 'expired'
            : 'invited';
      const alive = status === 'invited' || status === 'joined' || status === 'finished';
      return {
        memberId: m.id,
        role: m.role as Role,
        email: m.email,
        invitedBy: m.invitedBy,
        invitedAt: m.invitedAt,
        expiresAt: m.expiresAt,
        remindedAt: m.remindedAt,
        status,
        open: openCount,
        ...(alive
          ? { link: inviteLink(options.baseUrl, options.locale ?? 'en', m.inviteToken) }
          : {}),
      };
    });
  });
}

export interface OutboxMessage {
  readonly id: string;
  readonly kind: 'invitation' | 'reminder';
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly sentAt: Date | null;
}

export async function outboxFor(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<OutboxMessage[]> {
  return withTenant(connection, tenantId, async (db) => {
    const rows = await db
      .select()
      .from(mailOutbox)
      .where(and(eq(mailOutbox.caseId, caseId), isNull(mailOutbox.sentAt)))
      .orderBy(mailOutbox.createdAt);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as 'invitation' | 'reminder',
      to: r.to,
      subject: r.subject,
      body: r.body,
      createdAt: r.createdAt,
      sentAt: r.sentAt,
    }));
  });
}

export interface MemberView {
  readonly member: MemberByInvite;
  readonly caseId: string;
  readonly domain: string;
  // The member's own list, always; every list only once the owner has granted it.
  readonly lists: readonly RoleList[];
  // Findings the member may see, by id. Anything else on the case is not theirs.
  readonly visibleFindingIds: readonly string[];
}

export interface MemberViewOptions {
  readonly locale: Locale;
  // The remedy kind and title for a finding's remedy reference; from the catalogue.
  readonly remedy: (remedyId: string, version: number) => { kind: RemedyKind; title: string };
}

export async function memberView(
  connection: Connection,
  token: string,
  options: MemberViewOptions,
): Promise<MemberView | undefined> {
  const member = await memberByInvite(connection, token);
  if (!member) return undefined;
  return withTenant(connection, member.tenantId, async (db) => {
    const [c] = await db
      .select({ company: cases.company })
      .from(cases)
      .where(eq(cases.id, member.caseId))
      .limit(1);
    const domain = (c?.company as { domain?: string } | undefined)?.domain ?? 'unknown';
    const rows = await db.select().from(findings).where(eq(findings.caseId, member.caseId));
    const all: RoleFinding[] = rows.map((r) => {
      const remedy = options.remedy(r.remedyId, r.remedyVersion);
      return {
        id: r.id,
        typeId: r.typeId,
        area: r.area as RoleFinding['area'],
        severity: r.severity as RoleFinding['severity'],
        status: r.status as RoleFinding['status'],
        remedyKind: remedy.kind,
        title: remedy.title,
      };
    });
    const visible = member.grantedFull ? all : all.filter((f) => roleFor(f) === member.role);
    const lists = assembleRoleLists(visible, { locale: options.locale, domain }).filter(
      (l) => member.grantedFull || l.role === member.role,
    );
    return {
      member,
      caseId: member.caseId,
      domain,
      lists,
      visibleFindingIds: visible.map((f) => f.id),
    };
  });
}

// "I do not know, check it for me": the proposal goes to the agent as a job. The worker
// that runs it is A-05's; until then the job waits in the queue, which is the point.
export const CHECK_FOR_ME_JOB = defineJob({
  name: 'check-for-me',
  payload: TaskProposalSchema,
  retryLimit: 1,
});

export async function requestCheck(queue: JobQueue, proposal: TaskProposal): Promise<string> {
  return queue.enqueue(CHECK_FOR_ME_JOB, TaskProposalSchema.parse(proposal));
}
