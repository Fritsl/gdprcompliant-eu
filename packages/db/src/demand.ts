import { and, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Connection, Db } from './client.js';
import { demandEntries } from './schema.js';

// The demand ledger (R-05): the write path every no_solution takes from the first scan
// onward, and the ranked, anonymised read. Purpose and retention: docs/decisions/
// demand-ledger.md.

// What @gc/remedies hands over (its DemandRecord), plus what the case knows about the
// company. Declared here rather than imported so @gc/remedies stays free of the database.
export interface DemandWrite {
  readonly findingTypeId: string;
  readonly jurisdiction: string;
  readonly caseId: string;
  readonly gap: string;
  readonly cause: string;
  readonly answer: 'none' | 'partial' | 'ours';
  readonly sector?: string;
  readonly firstSeenAt?: string;
}

export interface CompanyBands {
  readonly country: string;
  readonly sector?: string;
  readonly sectorCode?: string;
  readonly headcountBand?: string;
}

// Writes as the tenant, inside withTenant(); the row carries the tenant so RLS lets it in.
export class PostgresDemandLedger {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
    private readonly company: CompanyBands,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(entry: DemandWrite): Promise<void> {
    const seenAt = entry.firstSeenAt ? new Date(entry.firstSeenAt) : this.now();
    const sector = entry.sector ?? this.company.sector ?? null;
    await this.db.insert(demandEntries).values({
      id: `${entry.caseId}:${entry.findingTypeId}:${entry.jurisdiction}:${seenAt.toISOString()}`,
      tenantId: this.tenantId,
      sourceRef: `case:${entry.caseId}`,
      caseId: entry.caseId,
      findingTypeId: entry.findingTypeId,
      jurisdiction: entry.jurisdiction,
      gap: entry.gap,
      cause: entry.cause,
      answer: entry.answer,
      sector,
      sectorCode: this.company.sectorCode ?? null,
      headcountBand: this.company.headcountBand ?? null,
      country: this.company.country,
      seenAt,
    });
  }
}

// One row of the ranked view. Counts and dates only; nothing joins back to a company.
export const RankedDemandRowSchema = z.object({
  findingTypeId: z.string().min(1),
  jurisdiction: z.string().min(1),
  // null on the rollup row for the finding type; set on a breakdown row.
  country: z.string().nullable(),
  sector: z.string().nullable(),
  headcountBand: z.string().nullable(),
  tenants: z.number().int().min(1),
  cases: z.number().int().min(1),
  entries: z.number().int().min(1),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});
export type RankedDemandRow = z.infer<typeof RankedDemandRowSchema>;

export const DEFAULT_K = 3;

// The only cross-tenant read: demand_ranked(k) runs as its definer and returns groups
// with at least k distinct tenants, most-hit first.
export async function rankedDemand(
  connection: Pick<Connection, 'sql'>,
  options: { k?: number } = {},
): Promise<RankedDemandRow[]> {
  const k = options.k ?? DEFAULT_K;
  if (!Number.isInteger(k) || k < 2)
    throw new Error(`k must be an integer of at least 2, not ${k}`);
  const rows = await connection.sql<
    {
      finding_type_id: string;
      jurisdiction: string;
      country: string | null;
      sector: string | null;
      headcount_band: string | null;
      tenants: number;
      cases: number;
      entries: number;
      first_seen_at: Date;
      last_seen_at: Date;
    }[]
  >`select * from demand_ranked(${k})`;
  return rows.map((r) =>
    RankedDemandRowSchema.parse({
      findingTypeId: r.finding_type_id,
      jurisdiction: r.jurisdiction,
      country: r.country,
      sector: r.sector,
      headcountBand: r.headcount_band,
      tenants: Number(r.tenants),
      cases: Number(r.cases),
      entries: Number(r.entries),
      firstSeenAt: new Date(r.first_seen_at).toISOString(),
      lastSeenAt: new Date(r.last_seen_at).toISOString(),
    }),
  );
}

export const DEMAND_CSV_COLUMNS = [
  'findingTypeId',
  'jurisdiction',
  'country',
  'sector',
  'headcountBand',
  'tenants',
  'cases',
  'entries',
  'firstSeenAt',
  'lastSeenAt',
] as const;

const cell = (v: string | number | null): string => {
  if (v === null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

// RFC 4180, header first, CRLF line ends, UTF-8 without a byte-order mark.
export function demandCsv(rows: readonly RankedDemandRow[]): string {
  const lines = [DEMAND_CSV_COLUMNS.join(',')];
  for (const r of rows) lines.push(DEMAND_CSV_COLUMNS.map((c) => cell(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

// Retention: rows older than the cut-off go. Runs as the owner; returns how many went.
export const DEMAND_RETENTION_MONTHS = 24;

export function demandRetentionCutoff(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - DEMAND_RETENTION_MONTHS);
  return d;
}

export async function purgeDemandEntries(
  db: Db,
  olderThan: Date = demandRetentionCutoff(),
): Promise<number> {
  const gone = await db
    .delete(demandEntries)
    .where(and(lt(demandEntries.seenAt, olderThan), sql`true`))
    .returning({ id: demandEntries.id });
  return gone.length;
}
