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
  vector,
} from 'drizzle-orm/pg-core';
import {
  ARTEFACT_KINDS,
  CASE_EVENT_TYPES,
  CASE_LANES,
  CORPUS_CHUNK_KINDS,
  CORPUS_EMBEDDING_DIMENSIONS,
  CASE_STAGES,
  EVIDENCE_KINDS,
  FINDING_AREAS,
  FINDING_STATUSES,
  REMEDY_KINDS,
  SEVERITIES,
  VENDOR_RESOLUTIONS,
  VENDOR_ROLES,
  VERIFIER_CHECKS,
  GRAPH_EDGE_KINDS,
  GRAPH_NODE_KINDS,
  GRAPH_ORIGINS,
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
    // The signals behind the score (L-01), for an internal reader; never exported.
    laneSignals: jsonb('lane_signals').notNull().default([]),
    // Referral (L-04): the code this case hands out, and the code it came from, if any.
    referralCode: text('referral_code'),
    referredBy: text('referred_by'),
    stage: text('stage').notNull().default('opened'),
    // Ownership (C-01). An unclaimed case is reachable only by its token, which is 256
    // random bits, and only until expires_at; claiming clears the expiry.
    accessToken: text('access_token')
      .notNull()
      .default(sql`replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')`),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    // The public progress page (U-05): off until published; the slug survives taking
    // it down so a company's link works again when it goes back up.
    trustSlug: text('trust_slug'),
    trustPublishedAt: timestamp('trust_published_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id], name: 'cases_tenant_fk' }),
    check('cases_id', sql`${t.id} ~ '^[A-Z]{2}-[0-9]{2}-[A-Z0-9]{4}$'`),
    check('cases_lane', oneOf('lane', CASE_LANES)),
    check('cases_stage', oneOf('stage', CASE_STAGES)),
    check('cases_lane_score', sql`${t.laneScore} between 0 and 100`),
    check('cases_token_length', sql`length(${t.accessToken}) >= 32`),
    uniqueIndex('cases_access_token').on(t.accessToken),
    uniqueIndex('cases_trust_slug').on(t.trustSlug),
    uniqueIndex('cases_referral_code').on(t.referralCode),
    check('cases_trust_slug', sql`${t.trustSlug} is null or ${t.trustSlug} ~ '^[a-f0-9]{16}$'`),
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
    // Every event names its actor (C-02): one of the kinds the contract knows.
    check(
      'case_events_actor',
      sql`coalesce(${t.actor}->>'kind', '') in ('person', 'agent', 'scanner', 'watcher', 'system')`,
    ),
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

// A colleague on a case (P-01): a role, an address, and an invitation token that is the
// one door to their list. They see their role's items, and the rest of the case only
// once the owner grants it.
export const caseMembers = pgTable(
  'case_members',
  {
    id: text('id').primaryKey(),
    ...stamped,
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    role: text('role').notNull(),
    email: text('email').notNull(),
    inviteToken: text('invite_token').notNull(),
    invitedAt: timestamp('invited_at', { withTimezone: true }).notNull(),
    // The person the invitation comes from, in their own name (P-02).
    invitedBy: text('invited_by').notNull().default(''),
    // Single-purpose, expiring, revocable: the link is dead after either.
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '14 days'`),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    grantedFull: boolean('granted_full').notNull().default(false),
  },
  (t) => [
    uniqueIndex('case_members_invite').on(t.inviteToken),
    uniqueIndex('case_members_case_email').on(t.caseId, t.email),
    check('case_members_role', oneOf('role', ['marketing', 'it', 'hr', 'finance'])),
    check('case_members_token_length', sql`length(${t.inviteToken}) >= 32`),
    index('case_members_case_idx').on(t.caseId),
  ],
);

// Share links (U-07): a read-only, one-screen summary for someone above the case. Each
// link is its own token, expiring and revocable; who it was for is on the row, so the
// holder can tell them apart, and on the timeline.
export const caseShares = pgTable(
  'case_shares',
  {
    id: text('id').primaryKey(),
    ...stamped,
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    kind: text('kind').notNull().default('upward'),
    token: text('token').notNull(),
    audience: text('audience').notNull().default(''),
    createdBy: text('created_by').notNull().default(''),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '90 days'`),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('case_shares_token').on(t.token),
    check('case_shares_kind', oneOf('kind', ['upward'])),
    check('case_shares_token_length', sql`length(${t.token}) >= 32`),
    index('case_shares_case_idx').on(t.caseId),
  ],
);

// Mail the case wants sent (P-02): invitations and reminders, written here and picked
// up by delivery. Counting rows here is what rate-limits the feature.
export const mailOutbox = pgTable(
  'mail_outbox',
  {
    id: text('id').primaryKey(),
    ...stamped,
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    kind: text('kind').notNull(),
    to: text('to').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    check('mail_outbox_kind', oneOf('kind', ['invitation', 'reminder'])),
    index('mail_outbox_case_idx').on(t.caseId, t.createdAt),
  ],
);

// What remains after a hard delete (C-04): that a case was deleted, when, and how much
// went. The id is the hash of the case number; nothing here names a company or a person.
export const deletionAudit = pgTable(
  'deletion_audit',
  {
    id: text('id').primaryKey(),
    ...stamped,
    country: text('country').notNull(),
    year: integer('year').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull(),
    requestedBy: text('requested_by').notNull(),
    rowsRemoved: integer('rows_removed').notNull(),
  },
  (t) => [
    check('deletion_audit_id', sql`${t.id} ~ '^[a-f0-9]{64}$'`),
    check('deletion_audit_shared', sql`${t.tenantId} = 'shared'`),
  ],
);

// Generated documents (A-09): one row per document, re-generated in place with a new
// version. A document leaves the system only after a named person has signed the
// version and the bytes they saw; a later regeneration clears the signature.
export const ARTEFACT_STATUSES = ['draft', 'signed', 'published'] as const;
export const artefacts = pgTable(
  'artefacts',
  {
    id: text('id').primaryKey(),
    ...stamped,
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    kind: text('kind').notNull(),
    locale: text('locale').notNull(),
    version: integer('version').notNull().default(1),
    content: text('content').notNull(),
    hash: text('hash').notNull(),
    status: text('status').notNull().default('draft'),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    generatedBy: jsonb('generated_by').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    signedBy: jsonb('signed_by'),
    signedVersion: integer('signed_version'),
    signedHash: text('signed_hash'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedUrl: text('published_url'),
  },
  (t) => [
    uniqueIndex('artefacts_case_kind').on(t.caseId, t.kind),
    check('artefacts_kind', oneOf('kind', ARTEFACT_KINDS)),
    check('artefacts_status', oneOf('status', ARTEFACT_STATUSES)),
    check('artefacts_hash', sql`${t.hash} ~ '^[a-f0-9]{64}$'`),
    // A signed or published row carries its signature; a draft carries none.
    check(
      'artefacts_signature',
      sql`(${t.status} = 'draft') = (${t.signedAt} IS NULL) AND (${t.status} = 'draft') = (${t.signedBy} IS NULL)`,
    ),
    check('artefacts_published', sql`(${t.status} = 'published') = (${t.publishedAt} IS NOT NULL)`),
  ],
);

// The verifier's verdicts (A-07): one row per claim checked, accepted or rejected, with
// the checks it ran and, for a rejection, the reason. A rejection sits in the internal
// review queue until someone has looked at it (reviewed_at).
export const claimVerdicts = pgTable(
  'claim_verdicts',
  {
    id: text('id').primaryKey(),
    ...stamped,
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    claimId: text('claim_id').notNull(),
    claimKind: text('claim_kind').notNull(),
    statement: text('statement').notNull(),
    verdict: text('verdict').notNull(),
    checks: jsonb('checks').notNull(),
    reason: text('reason'),
    at: timestamp('at', { withTimezone: true }).notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
  },
  (t) => [
    check('claim_verdicts_verdict', oneOf('verdict', ['accepted', 'rejected'])),
    check('claim_verdicts_kind', oneOf('claim_kind', ['observation', 'legal', 'drafting'])),
    check(
      'claim_verdicts_reason',
      sql`${t.verdict} = 'accepted' OR coalesce(${t.reason}, '') <> ''`,
    ),
    check(
      'claim_verdicts_checks',
      sql`jsonb_typeof(${t.checks}) = 'array' AND jsonb_array_length(${t.checks}) >= 1`,
    ),
    index('claim_verdicts_case_idx').on(t.caseId, t.at),
    index('claim_verdicts_queue_idx').on(t.verdict, t.reviewedAt, t.at),
  ],
);
// The check names the verdict rows may carry are the contract's; referenced here so
// the two cannot drift without a type error.
export const CLAIM_VERDICT_CHECKS = VERIFIER_CHECKS;

// The corpus (A-08): regulation, recitals, guidance and decisions cut into chunks that a
// citation resolves to exactly or not at all. Shared reference data, readable by every
// tenant; written only outside a tenant, by ingestion. A chunk speaks in one
// jurisdiction: 'EU' everywhere, a country code in that country alone. The key is
// instrument:article[:paragraph[:point]], one row per key and corpus version.
export const corpusChunks = pgTable(
  'corpus_chunks',
  {
    id: text('id').primaryKey(),
    ...stamped,
    corpusVersion: text('corpus_version').notNull(),
    instrument: text('instrument').notNull(),
    jurisdiction: text('jurisdiction').notNull(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    article: text('article').notNull(),
    paragraph: text('paragraph'),
    point: text('point'),
    heading: text('heading'),
    text: text('text').notNull(),
    hash: text('hash').notNull(),
    sourceUrl: text('source_url').notNull(),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull(),
    embedding: vector('embedding', { dimensions: CORPUS_EMBEDDING_DIMENSIONS }),
  },
  (t) => [
    uniqueIndex('corpus_chunks_key_version').on(t.instrument, t.corpusVersion, t.key),
    index('corpus_chunks_jurisdiction_idx').on(t.jurisdiction, t.corpusVersion),
    check('corpus_chunks_shared', sql`${t.tenantId} = 'shared'`),
    check('corpus_chunks_kind', oneOf('kind', CORPUS_CHUNK_KINDS)),
    check('corpus_chunks_jurisdiction', sql`${t.jurisdiction} ~ '^(EU|[A-Z]{2})$'`),
    check(
      'corpus_chunks_version',
      sql`${t.corpusVersion} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\\.[a-z0-9-]+)?$'`,
    ),
    check('corpus_chunks_hash', sql`${t.hash} ~ '^[a-f0-9]{64}$'`),
  ],
);

// The case graph (A-01): typed nodes and edges, each with where it came from, how sure
// it is and when. Derived facts point at evidence, asserted facts name a person,
// answered facts name the answer; the checks make that structural. Two nodes about one
// subject may disagree: both stay, a 'contradicts' edge joins them, and a person marks
// the loser superseded. Deleting is for the hard delete alone.
export const graphNodes = pgTable(
  'graph_nodes',
  {
    id: text('id').primaryKey(),
    ...stamped,
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    attributes: jsonb('attributes').notNull().default({}),
    origin: text('origin').notNull(),
    confidence: real('confidence').notNull(),
    evidence: jsonb('evidence').notNull().default([]),
    assertedBy: text('asserted_by'),
    answerId: text('answer_id'),
    at: timestamp('at', { withTimezone: true }).notNull(),
    supersededBy: text('superseded_by'),
  },
  (t) => [
    check('graph_nodes_kind', oneOf('kind', GRAPH_NODE_KINDS)),
    check('graph_nodes_origin', oneOf('origin', GRAPH_ORIGINS)),
    check('graph_nodes_confidence', sql`${t.confidence} between 0 and 1`),
    check('graph_nodes_evidence', sql`jsonb_typeof(${t.evidence}) = 'array'`),
    check(
      'graph_nodes_provenance',
      sql`(${t.origin} <> 'derived' OR jsonb_array_length(${t.evidence}) >= 1) AND (${t.origin} <> 'asserted' OR coalesce(${t.assertedBy}, '') <> '') AND (${t.origin} <> 'answered' OR coalesce(${t.answerId}, '') <> '')`,
    ),
    index('graph_nodes_case_idx').on(t.caseId, t.kind, t.key),
  ],
);

export const graphEdges = pgTable(
  'graph_edges',
  {
    id: text('id').primaryKey(),
    ...stamped,
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id),
    kind: text('kind').notNull(),
    fromNode: text('from_node')
      .notNull()
      .references(() => graphNodes.id),
    toNode: text('to_node')
      .notNull()
      .references(() => graphNodes.id),
    attributes: jsonb('attributes').notNull().default({}),
    origin: text('origin').notNull(),
    confidence: real('confidence').notNull(),
    evidence: jsonb('evidence').notNull().default([]),
    assertedBy: text('asserted_by'),
    answerId: text('answer_id'),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('graph_edges_kind', oneOf('kind', GRAPH_EDGE_KINDS)),
    check('graph_edges_origin', oneOf('origin', GRAPH_ORIGINS)),
    check('graph_edges_confidence', sql`${t.confidence} between 0 and 1`),
    check('graph_edges_evidence', sql`jsonb_typeof(${t.evidence}) = 'array'`),
    check(
      'graph_edges_provenance',
      sql`(${t.origin} <> 'derived' OR jsonb_array_length(${t.evidence}) >= 1) AND (${t.origin} <> 'asserted' OR coalesce(${t.assertedBy}, '') <> '') AND (${t.origin} <> 'answered' OR coalesce(${t.answerId}, '') <> '')`,
    ),
    check('graph_edges_ends', sql`${t.fromNode} <> ${t.toNode}`),
    uniqueIndex('graph_edges_unique').on(t.fromNode, t.toNode, t.kind),
    index('graph_edges_case_idx').on(t.caseId, t.kind),
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
  deletionAudit,
  caseMembers,
  caseShares,
  mailOutbox,
  corpusChunks,
  claimVerdicts,
  artefacts,
  graphNodes,
  graphEdges,
} as const;
