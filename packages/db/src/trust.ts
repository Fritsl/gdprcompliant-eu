import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { CompanySchema, type Actor, type Company } from '@gc/contracts';
import type { Connection } from './client.js';
import { cases } from './schema.js';
import { withTenant } from './tenant.js';
import { appendCaseEvent } from './timeline.js';

// The public progress page (U-05). Off by default. Publishing and taking down are
// explicit acts by the case's holder, each on the timeline. The page is read by its slug
// without a tenant context, through a definer function that hands out only what the
// page shows: what was fixed and when, how many things are open, when we last looked.
// Never an open finding, never a token.

export const TRUST_SLUG_PATTERN = /^[a-f0-9]{16}$/;
const newSlug = (): string => randomBytes(8).toString('hex');

export interface TrustPublication {
  readonly slug: string;
  readonly publishedAt: Date;
  // True when the page was already up; nothing changed and nothing was recorded.
  readonly already: boolean;
}

export async function publishTrustPage(
  connection: Connection,
  tenantId: string,
  caseId: string,
  options: { readonly by: Actor; readonly now?: Date },
): Promise<TrustPublication> {
  const now = options.now ?? new Date();
  return withTenant(connection, tenantId, async (db) => {
    const [row] = await db
      .select({ slug: cases.trustSlug, publishedAt: cases.trustPublishedAt })
      .from(cases)
      .where(eq(cases.id, caseId));
    if (!row) throw new Error(`no case ${caseId}`);
    if (row.slug && row.publishedAt)
      return { slug: row.slug, publishedAt: row.publishedAt, already: true };
    const slug = row.slug ?? newSlug();
    await db
      .update(cases)
      .set({ trustSlug: slug, trustPublishedAt: now })
      .where(eq(cases.id, caseId));
    await appendCaseEvent(db, {
      caseId,
      tenantId,
      type: 'trust_published',
      payload: { slug },
      actor: options.by,
      at: now,
    });
    return { slug, publishedAt: now, already: false };
  });
}

// Taking it down keeps the slug, so the same link works again if it goes back up.
export async function unpublishTrustPage(
  connection: Connection,
  tenantId: string,
  caseId: string,
  options: { readonly by: Actor; readonly now?: Date },
): Promise<boolean> {
  const now = options.now ?? new Date();
  return withTenant(connection, tenantId, async (db) => {
    const [row] = await db
      .select({ slug: cases.trustSlug, publishedAt: cases.trustPublishedAt })
      .from(cases)
      .where(eq(cases.id, caseId));
    if (!row?.slug || !row.publishedAt) return false;
    await db.update(cases).set({ trustPublishedAt: null }).where(eq(cases.id, caseId));
    await appendCaseEvent(db, {
      caseId,
      tenantId,
      type: 'trust_unpublished',
      payload: { slug: row.slug },
      actor: options.by,
      at: now,
    });
    return true;
  });
}

export interface TrustStatus {
  readonly slug: string | null;
  readonly publishedAt: Date | null;
}

export async function trustStatus(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<TrustStatus> {
  const [row] = await withTenant(connection, tenantId, (db) =>
    db
      .select({ slug: cases.trustSlug, publishedAt: cases.trustPublishedAt })
      .from(cases)
      .where(eq(cases.id, caseId)),
  );
  return { slug: row?.slug ?? null, publishedAt: row?.publishedAt ?? null };
}

export interface TrustFixed {
  readonly findingId: string;
  readonly typeId: string;
  readonly remedyId: string;
  readonly remedyVersion: number;
  readonly closedAt: Date;
}

export interface TrustPageView {
  readonly caseId: string;
  readonly company: Company;
  readonly locale: string;
  readonly jurisdiction: string;
  readonly publishedAt: Date;
  readonly lastCheckedAt: Date | null;
  readonly openCount: number;
  readonly fixed: readonly TrustFixed[];
}

// The page, by its slug, for anyone. Not published, or no such slug: nothing.
export async function trustPage(
  connection: Pick<Connection, 'sql'>,
  slug: string,
): Promise<TrustPageView | undefined> {
  if (!TRUST_SLUG_PATTERN.test(slug)) return undefined;
  const [row] = await connection.sql<
    {
      case_id: string;
      company: unknown;
      locale: string;
      jurisdiction: string;
      published_at: string;
      last_checked_at: string | null;
      open_count: number;
      fixed: {
        findingId: string;
        typeId: string;
        remedyId: string;
        remedyVersion: number;
        closedAt: string;
      }[];
    }[]
  >`select * from trust_page(${slug})`;
  if (!row) return undefined;
  return {
    caseId: row.case_id,
    company: CompanySchema.parse(row.company),
    locale: row.locale,
    jurisdiction: row.jurisdiction,
    publishedAt: new Date(row.published_at),
    lastCheckedAt: row.last_checked_at === null ? null : new Date(row.last_checked_at),
    openCount: Number(row.open_count),
    fixed: row.fixed.map((f) => ({ ...f, closedAt: new Date(f.closedAt) })),
  };
}
