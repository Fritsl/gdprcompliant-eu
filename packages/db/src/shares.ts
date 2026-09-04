import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Actor } from '@gc/contracts';
import type { Connection } from './client.js';
import { caseShares } from './schema.js';
import { withTenant } from './tenant.js';
import { appendCaseEvent } from './timeline.js';

// Upward sharing (U-07): a read-only summary link for someone above the case. Each link
// is its own token, says who it was for, expires, and dies the moment it is revoked. Both
// acts are the holder's and both are on the timeline. The link resolves through a
// definer function, because the reader has no tenant; it hands back the case and
// nothing else, and only while the link is alive.

export const SHARE_KINDS = ['upward'] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];
export const SHARE_DAYS = 90;
const MAX_AUDIENCE = 80;

const newToken = () => randomBytes(32).toString('hex');
const newId = () => `sh-${randomBytes(8).toString('hex')}`;

export interface ShareCreated {
  readonly shareId: string;
  readonly token: string;
  readonly kind: ShareKind;
  readonly audience: string;
  readonly expiresAt: Date;
}

export async function createShare(
  connection: Connection,
  tenantId: string,
  caseId: string,
  input: {
    readonly kind?: ShareKind;
    readonly audience: string;
    readonly by: Actor;
    readonly now?: Date;
  },
): Promise<ShareCreated> {
  const now = input.now ?? new Date();
  const audience = input.audience.trim().slice(0, MAX_AUDIENCE);
  const kind = input.kind ?? 'upward';
  const shareId = newId();
  const token = newToken();
  const expiresAt = new Date(now.getTime() + SHARE_DAYS * 86_400_000);
  const createdBy = input.by.kind === 'person' ? input.by.name : input.by.kind;
  return withTenant(connection, tenantId, async (db) => {
    await db.insert(caseShares).values({
      id: shareId,
      tenantId,
      sourceRef: `case:${caseId}`,
      caseId,
      kind,
      token,
      audience,
      createdBy,
      createdAt: now,
      expiresAt,
    });
    await appendCaseEvent(db, {
      caseId,
      tenantId,
      type: 'share_created',
      payload: { shareId, kind, ...(audience ? { audience } : {}) },
      actor: input.by,
      at: now,
    });
    return { shareId, token, kind, audience, expiresAt };
  });
}

export async function revokeShare(
  connection: Connection,
  tenantId: string,
  caseId: string,
  shareId: string,
  options: { readonly by: Actor; readonly now?: Date },
): Promise<boolean> {
  const now = options.now ?? new Date();
  return withTenant(connection, tenantId, async (db) => {
    const [row] = await db
      .select({ kind: caseShares.kind, revokedAt: caseShares.revokedAt })
      .from(caseShares)
      .where(and(eq(caseShares.id, shareId), eq(caseShares.caseId, caseId)));
    if (!row || row.revokedAt) return false;
    await db.update(caseShares).set({ revokedAt: now }).where(eq(caseShares.id, shareId));
    await appendCaseEvent(db, {
      caseId,
      tenantId,
      type: 'share_revoked',
      payload: { shareId, kind: row.kind as ShareKind },
      actor: options.by,
      at: now,
    });
    return true;
  });
}

export interface ShareSummary {
  readonly shareId: string;
  readonly kind: ShareKind;
  readonly audience: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly status: 'live' | 'revoked' | 'expired';
  // The link, for the holder to hand over; absent once dead.
  readonly link?: string;
}

export async function listShares(
  connection: Connection,
  tenantId: string,
  caseId: string,
  options: { readonly baseUrl: string; readonly locale: string; readonly now?: () => Date },
): Promise<ShareSummary[]> {
  const now = (options.now ?? (() => new Date()))();
  const rows = await withTenant(connection, tenantId, (db) =>
    db.select().from(caseShares).where(eq(caseShares.caseId, caseId)).orderBy(caseShares.createdAt),
  );
  return rows.map((r) => {
    const status = r.revokedAt ? 'revoked' : r.expiresAt <= now ? 'expired' : 'live';
    return {
      shareId: r.id,
      kind: r.kind as ShareKind,
      audience: r.audience,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      status,
      ...(status === 'live' ? { link: `${options.baseUrl}/${options.locale}/s/${r.token}` } : {}),
    };
  });
}

export interface ShareByToken {
  readonly shareId: string;
  readonly caseId: string;
  readonly tenantId: string;
  readonly kind: ShareKind;
  readonly audience: string;
}

// A live link, or nothing: revoked and expired links answer the same as unknown ones.
export async function shareByToken(
  connection: Pick<Connection, 'sql'>,
  token: string,
): Promise<ShareByToken | undefined> {
  if (!/^[0-9a-f]{32,128}$/.test(token)) return undefined;
  const [row] = await connection.sql<
    { share_id: string; case_id: string; tenant_id: string; kind: string; audience: string }[]
  >`select * from share_by_token(${token})`;
  if (!row) return undefined;
  return {
    shareId: row.share_id,
    caseId: row.case_id,
    tenantId: row.tenant_id,
    kind: row.kind as ShareKind,
    audience: row.audience,
  };
}

export const liveShares = (connection: Connection, tenantId: string, caseId: string) =>
  withTenant(connection, tenantId, (db) =>
    db
      .select({ id: caseShares.id })
      .from(caseShares)
      .where(and(eq(caseShares.caseId, caseId), isNull(caseShares.revokedAt))),
  );
