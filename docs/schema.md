# Schema

Generated from `packages/db/migrations/meta/0011_snapshot.json` by `scripts/schema-doc.mjs`.
Do not edit; change `packages/db/src/schema.ts`, run `pnpm db:generate`, then `pnpm db:doc`.

Every table carries `tenant_id`, `created_at` and `source_ref`. `case_events` and
`evidence` refuse UPDATE and DELETE; `findings.remedy_id` is NOT NULL.

```mermaid
erDiagram
  answers {
    text id "PK"
    text tenant_id
    timestamp created_at
    text source_ref
    text case_id
    text question_id
    text answer
    jsonb answered_by
    timestamp answered_at
  }
  app_meta {
    text key "PK"
    text value
    text tenant_id
    timestamp created_at
    text source_ref
    timestamp updated_at
  }
  case_claims {
    text id "PK"
    text tenant_id
    timestamp created_at
    text source_ref
    text case_id
    text email
    text code_hash
    timestamp expires_at
    timestamp used_at "nullable"
  }
  case_events {
    text id "PK"
    text tenant_id
    timestamp created_at
    text source_ref
    text case_id
    integer seq
    timestamp at
    jsonb actor
    text type
    jsonb payload
  }
  case_members {
    text id "PK"
    text tenant_id
    timestamp created_at
    text source_ref
    text case_id
    text role
    text email
    text invite_token
    timestamp invited_at
    text invited_by
    timestamp expires_at
    timestamp revoked_at "nullable"
    timestamp reminded_at "nullable"
    timestamp joined_at "nullable"
    boolean granted_full
  }
  cases {
    text id "PK"
    text tenant_id
    timestamp created_at
    text source_ref
    jsonb company
    text jurisdiction
    text locale
    timestamp opened_at
    jsonb owner "nullable"
    integer participants
    boolean watched
    text lane
    integer lane_score
    text stage
    text access_token
    timestamp expires_at "nullable"
    timestamp claimed_at "nullable"
    text claimed_by "nullable"
  }
  claim_verdicts {
    text id "PK"
    text tenant_id
    timestamp created_at
    text source_ref
    text case_id
    text claim_id
    text claim_kind
    text statement
    text verdict
    jsonb checks
    text reason "nullable"
    timestamp at
    timestamp reviewed_at "nullable"
    text reviewed_by "nullable"
  }
  corpus_chunks {
    text id "PK"
    text tenant_id
    timestamp created_at
    text source_ref
    text corpus_version
    text instrument
    text jurisdiction
    text kind
    text key
    text article
    text paragraph "nullable"
    text point "nullable"
    text heading "nullable"
    text text
    text hash
    text source_url
    timestamp retrieved_at
    vector______ embedding "nullable"
  }
  deletion_audit {
    text id "PK"
    text tenant_id
    timestamp created_at
    text source_ref
    text country
    integer year
    timestamp deleted_at
    text requested_by
    integer rows_removed
  }
  demand_entries {
    text id "PK"
    text tenant_id
    timestamp created_at
    text source_ref
    text case_id
    text finding_type_id
    text jurisdiction
    text gap
    text cause
    text answer
    text sector "nullable"
    text sector_code "nullable"
    text headcount_band "nullable"
    text country
    timestamp seen_at
  }
  evidence {
    text id "PK"
    text tenant_id
    timestamp created_at
    text source_ref
    text case_id
    text scan_id "nullable"
    text kind
    timestamp captured_at
    jsonb observed
    text body
    text hash
    text caption "nullable"
  }
  finding_evidence {
    text finding_id
    text evidence_id
    text tenant_id
    timestamp created_at
    text source_ref
    text quote "nullable"
  }
  findings {
    text id "PK"
    text tenant_id
    timestamp created_at
    text source_ref
    text case_id
    text scan_id "nullable"
    text type_id
    text fingerprint
    text jurisdiction
    jsonb binding
    text severity
    text status
    text area
    jsonb subject "nullable"
    text remedy_id
    integer remedy_version
    jsonb explanation "nullable"
    timestamp first_seen_at
    timestamp last_seen_at
    timestamp closed_at "nullable"
  }
  jurisdictions {
    text code "PK"
    text name
    boolean supported
    text tenant_id
    timestamp created_at
    text source_ref
  }
  mail_outbox {
    text id "PK"
    text tenant_id
    timestamp created_at
    text source_ref
    text case_id
    text kind
    text to
    text subject
    text body
    timestamp sent_at "nullable"
  }
  processing_activities {
    text id "PK"
    text tenant_id
    timestamp created_at
    text source_ref
    text case_id
    text name
    text purpose
    text legal_basis "nullable"
    jsonb data_categories
    jsonb data_subjects
    jsonb recipients
    text retention "nullable"
    jsonb transfer "nullable"
    text origin
    real confidence
  }
  remedies {
    text id
    integer version
    text tenant_id
    timestamp created_at
    text source_ref
    text finding_type_id
    text kind
    jsonb jurisdictions
    jsonb content
    text hash
  }
  tenants {
    text id "PK"
    text name
    text tenant_id
    timestamp created_at
    text source_ref
  }
  vendors {
    text id "PK"
    text tenant_id
    timestamp created_at
    text source_ref
    text case_id
    text label
    jsonb legal_entity "nullable"
    text jurisdiction
    text parent_jurisdiction "nullable"
    text role
    integer level
    text parent_vendor_id "nullable"
    jsonb hosts
    text resolution
    jsonb provenance
    jsonb transfer "nullable"
  }
  cases ||--o{ answers : "case_id"
  cases ||--o{ case_claims : "case_id"
  cases ||--o{ case_events : "case_id"
  cases ||--o{ case_members : "case_id"
  jurisdictions ||--o{ cases : "jurisdiction"
  tenants ||--o{ cases : "tenant_id"
  cases ||--o{ claim_verdicts : "case_id"
  cases ||--o{ demand_entries : "case_id"
  cases ||--o{ evidence : "case_id"
  findings ||--o{ finding_evidence : "finding_id"
  evidence ||--o{ finding_evidence : "evidence_id"
  cases ||--o{ findings : "case_id"
  jurisdictions ||--o{ findings : "jurisdiction"
  remedies ||--o{ findings : "remedy_id, remedy_version"
  cases ||--o{ mail_outbox : "case_id"
  cases ||--o{ processing_activities : "case_id"
  cases ||--o{ vendors : "case_id"
  vendors ||--o{ vendors : "parent_vendor_id"
```

## answers

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | primary key, not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| case_id | text | not null |
| question_id | text | not null |
| answer | text | not null |
| answered_by | jsonb | not null |
| answered_at | timestamp with time zone | not null |

- case_id → cases(id)
- unique index answers_case_question (case_id, question_id)

## app_meta

| Column | Type | Constraints |
| --- | --- | --- |
| key | text | primary key, not null |
| value | text | not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| updated_at | timestamp with time zone | not null, default now() |

## case_claims

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | primary key, not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| case_id | text | not null |
| email | text | not null |
| code_hash | text | not null |
| expires_at | timestamp with time zone | not null |
| used_at | timestamp with time zone |  |

- case_id → cases(id)
- index case_claims_case_idx (case_id)

## case_events

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | primary key, not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| case_id | text | not null |
| seq | integer | not null |
| at | timestamp with time zone | not null |
| actor | jsonb | not null |
| type | text | not null |
| payload | jsonb | not null, default '{}'::jsonb |

- case_id → cases(id)
- unique index case_events_case_seq (case_id, seq)
- index case_events_tenant_idx (tenant_id)
- check case_events_seq: `"case_events"."seq" >= 1`
- check case_events_type: `"type" in ('case_opened', 'scan_started', 'scan_completed', 'scan_failed', 'finding_raised', 'finding_closed', 'finding_regressed', 'fix_verification_failed', 'check_undetermined', 'question_asked', 'question_answered', 'artefact_generated', 'artefact_published', 'colleague_invited', 'colleague_joined', 'reminder_sent', 'invitation_revoked', 'watch_run', 'meeting_requested', 'note_added', 'locale_overridden', 'claim_rejected', 'claim_requested', 'case_claimed', 'case_expired', 'export_produced', 'deletion_requested', 'vendor_resolved')`
- check case_events_actor: `coalesce("case_events"."actor"->>'kind', '') in ('person', 'agent', 'scanner', 'watcher', 'system')`

## case_members

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | primary key, not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| case_id | text | not null |
| role | text | not null |
| email | text | not null |
| invite_token | text | not null |
| invited_at | timestamp with time zone | not null |
| invited_by | text | not null, default '' |
| expires_at | timestamp with time zone | not null, default now() + interval '14 days' |
| revoked_at | timestamp with time zone |  |
| reminded_at | timestamp with time zone |  |
| joined_at | timestamp with time zone |  |
| granted_full | boolean | not null, default false |

- case_id → cases(id)
- unique index case_members_invite (invite_token)
- unique index case_members_case_email (case_id, email)
- index case_members_case_idx (case_id)
- check case_members_role: `"role" in ('marketing', 'it', 'hr', 'finance')`
- check case_members_token_length: `length("case_members"."invite_token") >= 32`

## cases

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | primary key, not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| company | jsonb | not null |
| jurisdiction | text | not null |
| locale | text | not null |
| opened_at | timestamp with time zone | not null |
| owner | jsonb |  |
| participants | integer | not null, default 0 |
| watched | boolean | not null, default false |
| lane | text | not null |
| lane_score | integer | not null, default 0 |
| stage | text | not null, default 'opened' |
| access_token | text | not null, default replace(gen_random_uuid()::text \|\| gen_random_uuid()::text, '-', '') |
| expires_at | timestamp with time zone |  |
| claimed_at | timestamp with time zone |  |
| claimed_by | text |  |

- jurisdiction → jurisdictions(code)
- tenant_id → tenants(id)
- unique index cases_access_token (access_token)
- index cases_tenant_idx (tenant_id)
- index cases_domain_idx (tenant_id, ("company"->>'domain'))
- check cases_id: `"cases"."id" ~ '^[A-Z]{2}-[0-9]{2}-[A-Z0-9]{4}$'`
- check cases_lane: `"lane" in ('self-serve', 'human')`
- check cases_stage: `"stage" in ('opened', 'assessed', 'working', 'documented', 'watched')`
- check cases_lane_score: `"cases"."lane_score" between 0 and 100`
- check cases_token_length: `length("cases"."access_token") >= 32`

## claim_verdicts

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | primary key, not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| case_id | text | not null |
| claim_id | text | not null |
| claim_kind | text | not null |
| statement | text | not null |
| verdict | text | not null |
| checks | jsonb | not null |
| reason | text |  |
| at | timestamp with time zone | not null |
| reviewed_at | timestamp with time zone |  |
| reviewed_by | text |  |

- case_id → cases(id)
- index claim_verdicts_case_idx (case_id, at)
- index claim_verdicts_queue_idx (verdict, reviewed_at, at)
- check claim_verdicts_verdict: `"verdict" in ('accepted', 'rejected')`
- check claim_verdicts_kind: `"claim_kind" in ('observation', 'legal', 'drafting')`
- check claim_verdicts_reason: `"claim_verdicts"."verdict" = 'accepted' OR coalesce("claim_verdicts"."reason", '') <> ''`
- check claim_verdicts_checks: `jsonb_typeof("claim_verdicts"."checks") = 'array' AND jsonb_array_length("claim_verdicts"."checks") >= 1`

## corpus_chunks

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | primary key, not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| corpus_version | text | not null |
| instrument | text | not null |
| jurisdiction | text | not null |
| kind | text | not null |
| key | text | not null |
| article | text | not null |
| paragraph | text |  |
| point | text |  |
| heading | text |  |
| text | text | not null |
| hash | text | not null |
| source_url | text | not null |
| retrieved_at | timestamp with time zone | not null |
| embedding | vector(1024) |  |

- unique index corpus_chunks_key_version (instrument, corpus_version, key)
- index corpus_chunks_jurisdiction_idx (jurisdiction, corpus_version)
- check corpus_chunks_shared: `"corpus_chunks"."tenant_id" = 'shared'`
- check corpus_chunks_kind: `"kind" in ('article', 'recital', 'guidance', 'decision')`
- check corpus_chunks_jurisdiction: `"corpus_chunks"."jurisdiction" ~ '^(EU|[A-Z]{2})$'`
- check corpus_chunks_version: `"corpus_chunks"."corpus_version" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[a-z0-9-]+)?$'`
- check corpus_chunks_hash: `"corpus_chunks"."hash" ~ '^[a-f0-9]{64}$'`

## deletion_audit

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | primary key, not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| country | text | not null |
| year | integer | not null |
| deleted_at | timestamp with time zone | not null |
| requested_by | text | not null |
| rows_removed | integer | not null |

- check deletion_audit_id: `"deletion_audit"."id" ~ '^[a-f0-9]{64}$'`
- check deletion_audit_shared: `"deletion_audit"."tenant_id" = 'shared'`

## demand_entries

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | primary key, not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| case_id | text | not null |
| finding_type_id | text | not null |
| jurisdiction | text | not null |
| gap | text | not null |
| cause | text | not null |
| answer | text | not null |
| sector | text |  |
| sector_code | text |  |
| headcount_band | text |  |
| country | text | not null |
| seen_at | timestamp with time zone | not null |

- case_id → cases(id)
- index demand_entries_type_idx (finding_type_id, jurisdiction)
- index demand_entries_seen_idx (seen_at)
- check demand_entries_answer: `"answer" in ('none', 'partial', 'ours')`

## evidence

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | primary key, not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| case_id | text | not null |
| scan_id | text |  |
| kind | text | not null |
| captured_at | timestamp with time zone | not null |
| observed | jsonb | not null, default '{}'::jsonb |
| body | text | not null |
| hash | text | not null |
| caption | text |  |

- case_id → cases(id)
- unique index evidence_tenant_hash (tenant_id, hash)
- index evidence_case_idx (case_id)
- check evidence_hash: `"evidence"."hash" ~ '^[a-f0-9]{64}$'`
- check evidence_id: `"evidence"."id" = "evidence"."kind" || ':' || left("evidence"."hash", 16)`
- check evidence_kind: `"kind" in ('http_request', 'cookie', 'storage', 'dom_snapshot', 'screenshot', 'header', 'form', 'document', 'pass_diff', 'registry_record', 'answer', 'text')`

## finding_evidence

| Column | Type | Constraints |
| --- | --- | --- |
| finding_id | text | not null |
| evidence_id | text | not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| quote | text |  |

- primary key (finding_id, evidence_id)
- finding_id → findings(id)
- evidence_id → evidence(id)

## findings

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | primary key, not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| case_id | text | not null |
| scan_id | text |  |
| type_id | text | not null |
| fingerprint | text | not null |
| jurisdiction | text | not null |
| binding | jsonb | not null |
| severity | text | not null |
| status | text | not null, default 'open' |
| area | text | not null |
| subject | jsonb |  |
| remedy_id | text | not null |
| remedy_version | integer | not null |
| explanation | jsonb |  |
| first_seen_at | timestamp with time zone | not null |
| last_seen_at | timestamp with time zone | not null |
| closed_at | timestamp with time zone |  |

- case_id → cases(id)
- jurisdiction → jurisdictions(code)
- remedy_id, remedy_version → remedies(id, version)
- unique index findings_case_fingerprint (case_id, fingerprint)
- index findings_tenant_idx (tenant_id)
- check findings_type: `"findings"."type_id" ~ '^[A-Z]{2,4}-[0-9]{2}$'`
- check findings_severity: `"severity" in ('blocking', 'serious', 'advisory')`
- check findings_status: `"status" in ('open', 'working', 'closed', 'regressed')`
- check findings_area: `"area" in ('Consent', 'Contracts', 'Security', 'Transfers', 'Observation', 'Notice', 'Recipients', 'Collection')`
- check findings_closed: `("findings"."status" = 'closed') = ("findings"."closed_at" is not null)`

## jurisdictions

| Column | Type | Constraints |
| --- | --- | --- |
| code | text | primary key, not null |
| name | text | not null |
| supported | boolean | not null, default false |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |

- check jurisdictions_code: `"jurisdictions"."code" ~ '^(EU|[A-Z]{2})$'`

## mail_outbox

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | primary key, not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| case_id | text | not null |
| kind | text | not null |
| to | text | not null |
| subject | text | not null |
| body | text | not null |
| sent_at | timestamp with time zone |  |

- case_id → cases(id)
- index mail_outbox_case_idx (case_id, created_at)
- check mail_outbox_kind: `"kind" in ('invitation', 'reminder')`

## processing_activities

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | primary key, not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| case_id | text | not null |
| name | text | not null |
| purpose | text | not null |
| legal_basis | text |  |
| data_categories | jsonb | not null, default '[]'::jsonb |
| data_subjects | jsonb | not null, default '[]'::jsonb |
| recipients | jsonb | not null, default '[]'::jsonb |
| retention | text |  |
| transfer | jsonb |  |
| origin | text | not null |
| confidence | real | not null, default 1 |

- case_id → cases(id)
- index processing_activities_case_idx (case_id)
- check processing_activities_origin: `"origin" in ('derived', 'asserted', 'answered')`
- check processing_activities_confidence: `"processing_activities"."confidence" between 0 and 1`

## remedies

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | not null |
| version | integer | not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| finding_type_id | text | not null |
| kind | text | not null |
| jurisdictions | jsonb | not null |
| content | jsonb | not null |
| hash | text | not null |

- primary key (id, version)
- check remedies_version: `"remedies"."version" >= 1`
- check remedies_kind: `"kind" in ('self_fix', 'generated_artefact', 'our_product', 'partner_alternative', 'no_solution')`
- check remedies_finding_type: `"remedies"."finding_type_id" ~ '^[A-Z]{2,4}-[0-9]{2}$'`

## tenants

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | primary key, not null |
| name | text | not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |

- check tenants_self: `"tenants"."tenant_id" = "tenants"."id"`

## vendors

| Column | Type | Constraints |
| --- | --- | --- |
| id | text | primary key, not null |
| tenant_id | text | not null |
| created_at | timestamp with time zone | not null, default now() |
| source_ref | text | not null |
| case_id | text | not null |
| label | text | not null |
| legal_entity | jsonb |  |
| jurisdiction | text | not null |
| parent_jurisdiction | text |  |
| role | text | not null |
| level | integer | not null, default 1 |
| parent_vendor_id | text |  |
| hosts | jsonb | not null, default '[]'::jsonb |
| resolution | text | not null |
| provenance | jsonb | not null |
| transfer | jsonb |  |

- case_id → cases(id)
- parent_vendor_id → vendors(id)
- index vendors_case_idx (case_id)
- check vendors_role: `"role" in ('processor', 'sub_processor', 'joint_controller', 'independent_controller', 'unknown')`
- check vendors_resolution: `"resolution" in ('resolved', 'unresolved', 'ambiguous')`
- check vendors_level: `"vendors"."level" >= 0`

