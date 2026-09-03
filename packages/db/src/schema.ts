import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  CASE_EVENT_TYPES,
  CASE_LANES,
  CASE_STAGES,
  EVIDENCE_KINDS,
  FINDING_AREAS,
  FINDING_STATUSES,
  REMEDY_KINDS,
  SEVERITIES,
  VENDOR_RESOLUTIONS,
  VENDOR_ROLES,
} from '@gc/contracts';

// The relational spine (F-03). Every table carries the same three columns: tenant_id,
// so row-level security (F-05) has one thing to key on; created_at; and source_ref,
// which names where the row came from ("scanner:scan-1", "answer:Q3", "import:cvr").
// The product rules that must be structural are constraints here, not conventions:
// a finding cannot be inserted without a remedy, an evidence row cannot change, and
// a case event cannot be rewritten. Shapes mirror @gc/contracts; the enums are check
// constraints built from the same constants, so the two cannot drift.

// Reference data has no tenant of its own; it belongs to everyone.
export const SHARED_TENANT = 'shared';

const stamped = {
  tenantId: text('tenant_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sourceRef: text('source_ref').notNull(),
};

const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`"${column}" in (${values.map((v) => `'${v}'`).join(', ')})`);

// Facts about the database itself: schema version markers, seed stamps, and the like.
export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  ...stamped,
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tenants = pgTable(
  'tenants',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    ...stamped,
  },
  (t) => [check('tenants_self', sql`${t.tenantId} = ${t.id}`)],
);

export const jurisdictions = pgTable(
  'jurisdictions',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    // Whether bindings, remedies and guides ship for it (I-02).
    supported: boolean('supported').notNull().default(false),
    ...stamped,
  },
  (t) => [check('jurisdictions_code', sql`${t.code} ~ '^(EU|[A-Z]{2})$'`)],
);

export const cases = pgTable(
  'cases',
  {
    id: text('id').primaryKey(),
    ...stamped,
    company: jsonb('company').notNull(),
    jurisdiction: text('jurisdiction')
      .notNull()
      .references(() => jurisdictions.code),
    locale: text('locale').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    owner: jsonb('owner'),
    participants: integer('participants').notNull().default(0),
    watched: boolean('watched').notNull().default(false),
    lane: text('lane').notNull(),
    laneScore: integer('lane_score').notNull().default(0),
    stage: text('stage').notNull().default('opened'),
    // Ownership (C-01). An unclaimed case is reachable only by its token, which is 256
    // random bits, and only until expires_at; claiming clears the expiry.
    accessToken: text('access_token')
      .notNull()
      .default(sql`replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')`),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id], name: 'cases_tenant_fk' }),
    check('cases_id', sql`${t.id} ~ '^[A-Z]{2}-[0-9]{2}-[A-Z0-9]{4}$'`),
    check('cases_lane', oneOf('lane', CASE_LANES)),
    check('cases_stage', oneOf('stage', CASE_STAGES)),
    check('cases_lane_score', sql`${t.laneScore} between 0 and 100`),
    check('cases_token_length', sql`length(${t.accessToken}) >= 32`),
    uniqueIndex('cases_access_token').on(t.accessToken),
    index('cases_tenant_idx').on(t.tenantId),
    index('cases_domain_idx').on(t.tenantId, sql`(${t.company}->>'domain')`),
  ],
);

// A pending proof of control over an address at the scanned domain (C-01). The code
// itself is never stored, only its hash; it goes out by mail and comes back once.
export const caseClaims = pgTable(
  'case_claims',
  {
    id: text('id').primaryKey(),
    ...stamped,
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [index('case_claims_case_idx').on(t.caseId)],
);

// Append-only. A trigger in the migration raises on UPDATE and DELETE.
export const caseEvents = pgTable(
  'case_events',
  {
    id: text('id').primaryKey(),
    ...stamped,
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    seq: integer('seq').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    actor: jsonb('actor').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
  },
  (t) => [
    uniqueIndex('case_events_case_seq').on(t.caseId, t.seq),
    check('case_events_seq', sql`${t.seq} >= 1`),
    check('case_events_type', oneOf('type', CASE_EVENT_TYPES)),
    index('case_events_tenant_idx').on(t.tenantId),
  ],
);

// Immutable and content-addressed: the id is the kind and the hash, the hash is unique
// per tenant, and a trigger in the migration raises on UPDATE and DELETE.
export const evidence = pgTable(
  'evidence',
  {
    id: text('id').primaryKey(),
    ...stamped,
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    scanId: text('scan_id'),
    kind: text('kind').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    // Where it was observed: url, host, pass, registry, question (Evidence.source).
    observed: jsonb('observed').notNull().default({}),
    body: text('body').notNull(),
    hash: text('hash').notNull(),
    caption: text('caption'),
  },
  (t) => [
    uniqueIndex('evidence_tenant_hash').on(t.tenantId, t.hash),
    check('evidence_hash', sql`${t.hash} ~ '^[a-f0-9]{64}$'`),
    check('evidence_id', sql`${t.id} = ${t.kind} || ':' || left(${t.hash}, 16)`),
    check('evidence_kind', oneOf('kind', EVIDENCE_KINDS)),
    index('evidence_case_idx').on(t.caseId),
  ],
);

// The remedy catalogue, versioned: a finding points at one version and the row for
// that version never changes (R-01).
export const remedies = pgTable(
  'remedies',
  {
    id: text('id').notNull(),
    version: integer('version').notNull(),
    ...stamped,
    findingTypeId: text('finding_type_id').notNull(),
    kind: text('kind').notNull(),
    // 'all' or a list of jurisdiction codes.
    jurisdictions: jsonb('jurisdictions').notNull(),
    content: jsonb('content').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.version] }),
    check('remedies_version', sql`${t.version} >= 1`),
    check('remedies_kind', oneOf('kind', REMEDY_KINDS)),
    check('remedies_finding_type', sql`${t.findingTypeId} ~ '^[A-Z]{2,4}-[0-9]{2}$'`),
  ],
);

// A finding without a remedy cannot be inserted: remedy_id and remedy_version are NOT
// NULL and a foreign key to the catalogue (R-02).
export const findings = pgTable(
  'findings',
  {
    id: text('id').primaryKey(),
    ...stamped,
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    scanId: text('scan_id'),
    typeId: text('type_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    jurisdiction: text('jurisdiction')
      .notNull()
      .references(() => jurisdictions.code),
    binding: jsonb('binding').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull().default('open'),
    area: text('area').notNull(),
    subject: jsonb('subject'),
    remedyId: text('remedy_id').notNull(),
    remedyVersion: integer('remedy_version').notNull(),
    explanation: jsonb('explanation'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.remedyId, t.remedyVersion],
      foreignColumns: [remedies.id, remedies.version],
      name: 'findings_remedy_fk',
    }),
    uniqueIndex('findings_case_fingerprint').on(t.caseId, t.fingerprint),
    check('findings_type', sql`${t.typeId} ~ '^[A-Z]{2,4}-[0-9]{2}$'`),
    check('findings_severity', oneOf('severity', SEVERITIES)),
    check('findings_status', oneOf('status', FINDING_STATUSES)),
    check('findings_area', oneOf('area', FINDING_AREAS)),
    check('findings_closed', sql`(${t.status} = 'closed') = (${t.closedAt} is not null)`),
    index('findings_tenant_idx').on(t.tenantId),
  ],
);

// Which evidence a finding rests on, and the quote it takes from it (A-07 checks the
// quote against the body). A finding must have at least one row here; assembly (S-14)
// enforces that, since a constraint across two tables needs a transaction.
export const findingEvidence = pgTable(
  'finding_evidence',
  {
    findingId: text('finding_id')
      .notNull()
      .references(() => findings.id),
    evidenceId: text('evidence_id')
      .notNull()
      .references(() => evidence.id),
    ...stamped,
    quote: text('quote'),
  },
  (t) => [primaryKey({ columns: [t.findingId, t.evidenceId] })],
);

export const vendors = pgTable(
  'vendors',
  {
    id: text('id').primaryKey(),
    ...stamped,
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    label: text('label').notNull(),
    legalEntity: jsonb('legal_entity'),
    jurisdiction: text('jurisdiction').notNull(),
    parentJurisdiction: text('parent_jurisdiction'),
    role: text('role').notNull(),
    level: integer('level').notNull().default(1),
    parentVendorId: text('parent_vendor_id'),
    hosts: jsonb('hosts').notNull().default([]),
    resolution: text('resolution').notNull(),
    provenance: jsonb('provenance').notNull(),
    transfer: jsonb('transfer'),
  },
  (t) => [
    foreignKey({ columns: [t.parentVendorId], foreignColumns: [t.id], name: 'vendors_parent_fk' }),
    check('vendors_role', oneOf('role', VENDOR_ROLES)),
    check('vendors_resolution', oneOf('resolution', VENDOR_RESOLUTIONS)),
    check('vendors_level', sql`${t.level} >= 0`),
    index('vendors_case_idx').on(t.caseId),
  ],
);

// The register's rows (G-01), as a projection of the case graph (A-01). Each says
// whether it was derived by code, asserted by a model, or answered by a person.
export const processingActivities = pgTable(
  'processing_activities',
  {
    id: text('id').primaryKey(),
    ...stamped,
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    name: text('name').notNull(),
    purpose: text('purpose').notNull(),
    legalBasis: text('legal_basis'),
    dataCategories: jsonb('data_categories').notNull().default([]),
    dataSubjects: jsonb('data_subjects').notNull().default([]),
    recipients: jsonb('recipients').notNull().default([]),
    retention: text('retention'),
    transfer: jsonb('transfer'),
    origin: text('origin').notNull(),
    confidence: real('confidence').notNull().default(1),
  },
  (t) => [
    check('processing_activities_origin', oneOf('origin', ['derived', 'asserted', 'answered'])),
    check('processing_activities_confidence', sql`${t.confidence} between 0 and 1`),
    index('processing_activities_case_idx').on(t.caseId),
  ],
);

export const answers = pgTable(
  'answers',
  {
    id: text('id').primaryKey(),
    ...stamped,
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    questionId: text('question_id').notNull(),
    answer: text('answer').notNull(),
    answeredBy: jsonb('answered_by').notNull(),
    answeredAt: timestamp('answered_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('answers_case_question').on(t.caseId, t.questionId)],
);

// The demand ledger (R-05): every no_solution outcome, with the company's bands and
// never its name. Read across tenants only through demand_ranked(k), which is defined
// in the migration. Purpose and retention: docs/decisions/demand-ledger.md.
export const demandEntries = pgTable(
  'demand_entries',
  {
    id: text('id').primaryKey(),
    ...stamped,
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    findingTypeId: text('finding_type_id').notNull(),
    jurisdiction: text('jurisdiction').notNull(),
    gap: text('gap').notNull(),
    cause: text('cause').notNull(),
    answer: text('answer').notNull(),
    sector: text('sector'),
    sectorCode: text('sector_code'),
    headcountBand: text('headcount_band'),
    country: text('country').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('demand_entries_answer', oneOf('answer', ['none', 'partial', 'ours'])),
    index('demand_entries_type_idx').on(t.findingTypeId, t.jurisdiction),
    index('demand_entries_seen_idx').on(t.seenAt),
  ],
);

export const TABLES = {
  appMeta,
  tenants,
  jurisdictions,
  cases,
  caseEvents,
  evidence,
  remedies,
  findings,
  findingEvidence,
  vendors,
  processingActivities,
  answers,
  demandEntries,
  caseClaims,
} as const;
