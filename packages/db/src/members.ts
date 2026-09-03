import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { TaskProposalSchema, type Locale, type RemedyKind, type TaskProposal } from '@gc/contracts';
import {
  assembleRoleLists,
  roleFor,
  type Role,
  type RoleFinding,
  type RoleList,
} from '@gc/findings';
import { defineJob, type JobQueue } from '@gc/jobs';
import type { Connection } from './client.js';
import { caseMembers, cases, findings } from './schema.js';
import { withTenant } from './tenant.js';
import { appendCaseEvent } from './timeline.js';

// Colleagues on a case (P-01): invited by the owner into a role, reaching their list by
// an invitation token, seeing only that role's items until the owner grants the rest.
// Visibility is enforced where the rows are read, not where the page is drawn.

export interface InviteInput {
  readonly caseId: string;
  readonly tenantId: string;
  readonly role: Role;
  readonly email: string;
  readonly now?: () => Date;
}

export interface Invitation {
  readonly memberId: string;
  readonly inviteToken: string;
  readonly role: Role;
}

const newToken = () => randomBytes(32).toString('hex');

export async function inviteMember(
  connection: Connection,
  input: InviteInput,
): Promise<Invitation> {
  const now = (input.now ?? (() => new Date()))();
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error(`not an address: ${input.email}`);
  return withTenant(connection, input.tenantId, async (db) => {
    const [c] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(eq(cases.id, input.caseId))
      .limit(1);
    if (!c) throw new Error(`no case ${input.caseId}`);
    const inviteToken = newToken();
    const memberId = `member:${inviteToken.slice(0, 16)}`;
    await db.insert(caseMembers).values({
      id: memberId,
      tenantId: input.tenantId,
      sourceRef: `case:${input.caseId}`,
      caseId: input.caseId,
      role: input.role,
      email,
      inviteToken,
      invitedAt: now,
    });
    await appendCaseEvent(db, {
      tenantId: input.tenantId,
      caseId: input.caseId,
      at: now,
      actor: { kind: 'system' },
      type: 'colleague_invited',
      payload: { role: input.role },
    });
    return { memberId, inviteToken, role: input.role };
  });
}

export interface MemberByInvite {
  readonly memberId: string;
  readonly caseId: string;
  readonly tenantId: string;
  readonly role: Role;
  readonly joined: boolean;
  readonly grantedFull: boolean;
}

// The token is the only way to a member's list. A definer function resolves it, since
// the holder has no tenant context yet.
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
    joined: row.joined_at !== null,
    grantedFull: row.granted_full,
  };
}

// First visit: the invitation becomes a membership, on the timeline.
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

export interface MemberView {
  readonly member: MemberByInvite;
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
    return { member, domain, lists, visibleFindingIds: visible.map((f) => f.id) };
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
