import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import {
  CASE_NUMBER_ALPHABET,
  CASE_NUMBER_PATTERN,
  CompanySchema,
  describeUnresolved,
  inferTarget,
  sha256,
  type Actor,
  type Company,
  type TargetInference,
  type TargetSignals,
  type TargetUnresolved,
} from '@gc/contracts';
import type { Connection } from './client.js';
import { caseClaims, caseEvents, cases, tenants } from './schema.js';
import { withTenant } from './tenant.js';
import { appendEvent } from './timeline.js';

// The case object (C-01): opens on the first scan with a number a person can read out,
// under a tenant of its own and no account; reachable by its token until it expires;
// claimed by proving control of an address at the scanned domain, or by an explicit
// override that leaves a trace; and continued rather than duplicated when the same
// owner scans the same domain again.

export const UNCLAIMED_CASE_TTL_DAYS = 30;
export const CLAIM_CODE_TTL_HOURS = 24;

// ---- numbering --------------------------------------------------------------------

export type Random = (max: number) => number;
const defaultRandom: Random = (max) => randomInt(max);

export function newCaseNumber(country: string, now: Date, random: Random = defaultRandom): string {
  const cc = country.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) throw new Error(`not a country code: ${country}`);
  const yy = String(now.getUTCFullYear() % 100).padStart(2, '0');
  let tail = '';
  for (let i = 0; i < 4; i += 1) {
    tail += CASE_NUMBER_ALPHABET[random(CASE_NUMBER_ALPHABET.length)];
  }
  const id = `${cc}-${yy}-${tail}`;
  if (!CASE_NUMBER_PATTERN.test(id)) throw new Error(`generated an unreadable number: ${id}`);
  return id;
}

export const newTenantId = (): string => `t-${randomBytes(9).toString('hex')}`;
const newToken = (): string => randomBytes(32).toString('hex');
const newClaimCode = (): string => randomBytes(16).toString('hex');

// ---- opening ----------------------------------------------------------------------

export interface OpenCaseInput {
  readonly company: Company;
  readonly jurisdiction: string;
  readonly locale: string;
  readonly lane?: 'self-serve' | 'human';
  readonly source?: 'scanner' | 'invite' | 'internal';
  // The owner's tenant, when known. Without one the case gets a tenant of its own.
  readonly tenantId?: string;
  readonly now?: () => Date;
  readonly random?: Random;
  // The referral code of the case whose link started this scan (L-04), if any.
  readonly referredBy?: string;
}

export interface OpenedCase {
  readonly caseId: string;
  readonly tenantId: string;
  readonly accessToken: string;
  readonly expiresAt: Date | null;
  // true when an existing case for the same domain and owner was returned instead.
  readonly continued: boolean;
}

// Opens a case; or, when the owner is known and already has a live case for the same
// domain, returns that one. Runs as the app role for the case's tenant throughout.
export async function openCase(connection: Connection, input: OpenCaseInput): Promise<OpenedCase> {
  const company = CompanySchema.parse(input.company);
  const now = (input.now ?? (() => new Date()))();
  const tenantId = input.tenantId ?? newTenantId();

  return withTenant(connection, tenantId, async (db) => {
    if (input.tenantId) {
      const [existing] = await db
        .select()
        .from(cases)
        .where(
          and(
            eq(cases.tenantId, tenantId),
            sql`${cases.company}->>'domain' = ${company.domain}`,
            or(isNull(cases.expiresAt), gt(cases.expiresAt, now)),
          ),
        )
        .limit(1);
      if (existing) {
        return {
          caseId: existing.id,
          tenantId,
          accessToken: existing.accessToken,
          expiresAt: existing.expiresAt,
          continued: true,
        };
      }
    } else {
      await db.insert(tenants).values({
        id: tenantId,
        name: company.legalName ?? company.domain,
        tenantId,
        sourceRef: 'case:open',
      });
    }

    const accessToken = newToken();
    const expiresAt = new Date(now.getTime() + UNCLAIMED_CASE_TTL_DAYS * 86_400_000);
    let caseId = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      caseId = newCaseNumber(company.country, now, input.random);
      const inserted = await db
        .insert(cases)
        .values({
          id: caseId,
          tenantId,
          sourceRef: `open:${input.source ?? 'scanner'}`,
          company,
          jurisdiction: input.jurisdiction,
          locale: input.locale,
          openedAt: now,
          lane: input.lane ?? 'self-serve',
          accessToken,
          expiresAt,
          referralCode: referralCodeOf(caseId),
          ...(input.referredBy ? { referredBy: input.referredBy } : {}),
        })
        .onConflictDoNothing({ target: cases.id })
        .returning({ id: cases.id });
      if (inserted.length === 1) break;
      caseId = '';
    }
    if (!caseId) throw new Error('could not find a free case number in eight attempts');

    await appendEvent(db, tenantId, caseId, now, { kind: 'scanner' }, 'case_opened', {
      source: input.source ?? 'scanner',
    });
    return { caseId, tenantId, accessToken, expiresAt, continued: false };
  });
}

// ---- reaching an unclaimed case ---------------------------------------------------

export interface CaseByToken {
  readonly caseId: string;
  readonly tenantId: string;
  readonly claimed: boolean;
  readonly expiresAt: Date | null;
}

// The token is the only way to an unclaimed case. Resolved by a definer function, since
// the holder has no tenant context yet; an expired case is not found.
export async function caseByToken(
  connection: Pick<Connection, 'sql'>,
  token: string,
): Promise<CaseByToken | undefined> {
  if (!/^[0-9a-f]{32,128}$/.test(token)) return undefined;
  const [row] = await connection.sql<
    { case_id: string; tenant_id: string; claimed_at: string | null; expires_at: string | null }[]
  >`select * from case_by_token(${token})`;
  if (!row) return undefined;
  return {
    caseId: row.case_id,
    tenantId: row.tenant_id,
    claimed: row.claimed_at !== null,
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
  };
}

// ---- claiming ---------------------------------------------------------------------

export class ClaimRefused extends Error {
  constructor(
    readonly reason: 'wrong_domain' | 'not_found' | 'already_claimed' | 'bad_code' | 'expired',
    message: string,
  ) {
    super(message);
    this.name = 'ClaimRefused';
  }
}

// mette@eksempelbutik.dk and mette@mail.eksempelbutik.dk prove eksempelbutik.dk;
// mette@gmail.com and mette@eksempelbutik.dk.evil.test do not.
export function emailAtDomain(email: string, domain: string): boolean {
  const m = /^[^\s@]+@([^\s@]+)$/.exec(email.trim());
  if (!m) return false;
  const host = m[1]!.toLowerCase();
  const d = domain.toLowerCase().replace(/^www\./, '');
  return host === d || host.endsWith(`.${d}`);
}

export interface ClaimRequest {
  readonly caseId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly now?: () => Date;
}

export interface ClaimChallenge {
  readonly claimId: string;
  // Goes to the address by mail, once. Not stored; only its hash is.
  readonly code: string;
  readonly expiresAt: Date;
}

export async function requestClaim(
  connection: Connection,
  input: ClaimRequest,
): Promise<ClaimChallenge> {
  const now = (input.now ?? (() => new Date()))();
  return withTenant(connection, input.tenantId, async (db) => {
    const [c] = await db.select().from(cases).where(eq(cases.id, input.caseId)).limit(1);
    if (!c) throw new ClaimRefused('not_found', `no case ${input.caseId}`);
    if (c.claimedAt)
      throw new ClaimRefused('already_claimed', `${input.caseId} is already claimed`);
    if (c.expiresAt && c.expiresAt <= now)
      throw new ClaimRefused('expired', `${input.caseId} has expired`);
    const domain = (c.company as Company).domain;
    if (!emailAtDomain(input.email, domain)) {
      throw new ClaimRefused('wrong_domain', `${input.email} is not an address at ${domain}`);
    }
    const code = newClaimCode();
    const claimId = `claim:${sha256(code).slice(0, 16)}`;
    const expiresAt = new Date(now.getTime() + CLAIM_CODE_TTL_HOURS * 3_600_000);
    await db.insert(caseClaims).values({
      id: claimId,
      tenantId: input.tenantId,
      sourceRef: `case:${input.caseId}`,
      caseId: input.caseId,
      email: input.email.trim().toLowerCase(),
      codeHash: sha256(code),
      expiresAt,
    });
    await appendEvent(
      db,
      input.tenantId,
      input.caseId,
      now,
      { kind: 'system' },
      'claim_requested',
      {
        claimId,
        email: input.email.trim().toLowerCase(),
      },
    );
    return { claimId, code, expiresAt };
  });
}

export interface ClaimConfirmation {
  readonly caseId: string;
  readonly tenantId: string;
  readonly code: string;
  readonly now?: () => Date;
}

// The code comes back. Right: the case is claimed and stops expiring. Wrong or late:
// refused, and the refusal is on the timeline.
export async function confirmClaim(
  connection: Connection,
  input: ClaimConfirmation,
): Promise<{ email: string }> {
  const now = (input.now ?? (() => new Date()))();
  const hash = sha256(input.code.trim());
  // Looked up and, if refused, recorded in a transaction of its own: a refusal is a
  // fact on the timeline, and throwing inside the claiming transaction would undo it.
  const claim = await withTenant(connection, input.tenantId, async (db) => {
    const [found] = await db
      .select()
      .from(caseClaims)
      .where(
        and(
          eq(caseClaims.caseId, input.caseId),
          eq(caseClaims.codeHash, hash),
          isNull(caseClaims.usedAt),
        ),
      )
      .limit(1);
    if (found && found.expiresAt > now) return found;
    await appendEvent(db, input.tenantId, input.caseId, now, { kind: 'system' }, 'claim_rejected', {
      claimId: found?.id ?? 'claim:unknown',
      reason: found ? 'code expired' : 'code did not match an open claim',
    });
    return found ? 'expired' : 'bad_code';
  });
  if (typeof claim === 'string') throw new ClaimRefused(claim, `claim on ${input.caseId} refused`);

  return withTenant(connection, input.tenantId, async (db) => {
    await db.update(caseClaims).set({ usedAt: now }).where(eq(caseClaims.id, claim.id));
    await db
      .update(cases)
      .set({ claimedAt: now, claimedBy: claim.email, expiresAt: null })
      .where(eq(cases.id, input.caseId));
    await appendEvent(db, input.tenantId, input.caseId, now, { kind: 'system' }, 'case_claimed', {
      method: 'email',
      email: claim.email,
    });
    return { email: claim.email };
  });
}

export interface ClaimOverride {
  readonly caseId: string;
  readonly tenantId: string;
  // Who is vouching, and why the address route was not possible. Both go on the timeline.
  readonly by: string;
  readonly reason: string;
  readonly now?: () => Date;
}

export async function claimByOverride(connection: Connection, input: ClaimOverride): Promise<void> {
  const now = (input.now ?? (() => new Date()))();
  if (!input.by.trim() || !input.reason.trim()) throw new Error('an override names who and why');
  await withTenant(connection, input.tenantId, async (db) => {
    const [c] = await db.select().from(cases).where(eq(cases.id, input.caseId)).limit(1);
    if (!c) throw new ClaimRefused('not_found', `no case ${input.caseId}`);
    if (c.claimedAt)
      throw new ClaimRefused('already_claimed', `${input.caseId} is already claimed`);
    await db
      .update(cases)
      .set({ claimedAt: now, claimedBy: `override:${input.by.trim()}`, expiresAt: null })
      .where(eq(cases.id, input.caseId));
    await appendEvent(db, input.tenantId, input.caseId, now, { kind: 'system' }, 'case_claimed', {
      method: 'override',
      by: input.by.trim(),
      reason: input.reason.trim(),
    });
  });
}

// ---- expiry -----------------------------------------------------------------------

// Runs as the owner, across tenants: every unclaimed case past its expiry gets a closing
// event, once. The token stops working the moment expires_at passes regardless.
export async function expireUnclaimedCases(
  connection: Connection,
  now: Date = new Date(),
): Promise<string[]> {
  const due = await connection.db
    .select({ id: cases.id, tenantId: cases.tenantId, openedAt: cases.openedAt })
    .from(cases)
    .where(and(isNull(cases.claimedAt), lt(cases.expiresAt, now)));
  const expired: string[] = [];
  for (const c of due) {
    const [already] = await connection.db
      .select({ id: caseEvents.id })
      .from(caseEvents)
      .where(and(eq(caseEvents.caseId, c.id), eq(caseEvents.type, 'case_expired')))
      .limit(1);
    if (already) continue;
    await withTenant(connection, c.tenantId, (db) =>
      appendEvent(db, c.tenantId, c.id, now, { kind: 'system' }, 'case_expired', {
        unclaimedFor: Math.floor((now.getTime() - c.openedAt.getTime()) / 86_400_000),
      }),
    );
    expired.push(c.id);
  }
  return expired;
}

// ---- the target's locale (I-03) ---------------------------------------------------

export class UnsupportedTarget extends Error {
  constructor(public readonly resolution: TargetUnresolved) {
    super(`cannot open a case for this target: ${describeUnresolved(resolution)}`);
    this.name = 'UnsupportedTarget';
  }
}

export interface OpenForTargetInput extends Omit<
  OpenCaseInput,
  'company' | 'jurisdiction' | 'locale'
> {
  // What is known about the target: its declared language, its domain, its register entry.
  readonly signals: TargetSignals;
  readonly company?: Partial<Omit<Company, 'domain' | 'country' | 'locale'>>;
}

// A case for a target, in the target's jurisdiction and language, whoever is scanning.
export async function openCaseForTarget(
  connection: Connection,
  input: OpenForTargetInput,
): Promise<OpenedCase & { readonly target: TargetInference }> {
  const r = inferTarget(input.signals);
  if (!r.ok) throw new UnsupportedTarget(r);
  const { signals, company, ...rest } = input;
  const opened = await openCase(connection, {
    ...rest,
    company: { ...company, domain: signals.domain, country: r.jurisdiction, locale: r.locale },
    jurisdiction: r.jurisdiction,
    locale: r.locale,
  });
  return {
    ...opened,
    target: { jurisdiction: r.jurisdiction, locale: r.locale, basis: r.basis, signal: r.signal },
  };
}

export async function caseLocale(connection: Connection, tenantId: string, caseId: string) {
  return withTenant(connection, tenantId, async (db) => {
    const [row] = await db.select({ locale: cases.locale }).from(cases).where(eq(cases.id, caseId));
    if (!row) throw new Error(`no case ${caseId}`);
    return row.locale;
  });
}

// The visitor's choice of language for their case. Remembered on the case and on the
// timeline; the jurisdiction is not theirs to change.
export async function overrideCaseLocale(
  connection: Connection,
  tenantId: string,
  caseId: string,
  locale: string,
  actor: Actor,
  now: Date = new Date(),
): Promise<{ from: string; to: string; changed: boolean }> {
  return withTenant(connection, tenantId, async (db) => {
    const [row] = await db.select({ locale: cases.locale }).from(cases).where(eq(cases.id, caseId));
    if (!row) throw new Error(`no case ${caseId}`);
    if (row.locale === locale) return { from: row.locale, to: locale, changed: false };
    await db.update(cases).set({ locale }).where(eq(cases.id, caseId));
    await appendEvent(db, tenantId, caseId, now, actor, 'locale_overridden', {
      from: row.locale,
      to: locale,
    });
    return { from: row.locale, to: locale, changed: true };
  });
}

// ---- referral (L-04) --------------------------------------------------------------

// The code a case hands out: derived from its number, twelve hex characters, no secret
// in it. Anyone holding it can only attribute a new scan to this case.
export const referralCodeOf = (caseId: string): string =>
  createHash('sha256').update(`ref:${caseId}`).digest('hex').slice(0, 12);

export interface Referral {
  readonly code: string;
  readonly referredBy: string | null;
  readonly count: number;
}

// How many cases were opened from this case's link. Counted as the owner across
// tenants, because the referred cases belong to other companies; a number only.
export async function countReferrals(connection: Connection, code: string): Promise<number> {
  const [row] = await connection.db
    .select({ n: sql<number>`count(*)::int` })
    .from(cases)
    .where(eq(cases.referredBy, code));
  return row?.n ?? 0;
}

export async function referralOf(
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<Referral> {
  const [row] = await withTenant(connection, tenantId, (db) =>
    db
      .select({ code: cases.referralCode, referredBy: cases.referredBy })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1),
  );
  const code = row?.code ?? referralCodeOf(caseId);
  return {
    code,
    referredBy: row?.referredBy ?? null,
    count: await countReferrals(connection, code),
  };
}
