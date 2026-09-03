CREATE TABLE "answers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"case_id" text NOT NULL,
	"question_id" text NOT NULL,
	"answer" text NOT NULL,
	"answered_by" jsonb NOT NULL,
	"answered_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"case_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" jsonb NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "case_events_seq" CHECK ("case_events"."seq" >= 1),
	CONSTRAINT "case_events_type" CHECK ("type" in ('case_opened', 'scan_started', 'scan_completed', 'scan_failed', 'finding_raised', 'finding_closed', 'finding_regressed', 'fix_verification_failed', 'check_undetermined', 'question_asked', 'question_answered', 'artefact_generated', 'artefact_published', 'colleague_invited', 'colleague_joined', 'reminder_sent', 'watch_run', 'meeting_requested', 'note_added', 'claim_rejected', 'vendor_resolved'))
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"company" jsonb NOT NULL,
	"jurisdiction" text NOT NULL,
	"locale" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"owner" jsonb,
	"participants" integer DEFAULT 0 NOT NULL,
	"watched" boolean DEFAULT false NOT NULL,
	"lane" text NOT NULL,
	"lane_score" integer DEFAULT 0 NOT NULL,
	"stage" text DEFAULT 'opened' NOT NULL,
	CONSTRAINT "cases_id" CHECK ("cases"."id" ~ '^[A-Z]{2}-[0-9]{2}-[A-Z0-9]{4}$'),
	CONSTRAINT "cases_lane" CHECK ("lane" in ('self-serve', 'human')),
	CONSTRAINT "cases_stage" CHECK ("stage" in ('opened', 'assessed', 'working', 'documented', 'watched')),
	CONSTRAINT "cases_lane_score" CHECK ("cases"."lane_score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"case_id" text NOT NULL,
	"scan_id" text,
	"kind" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"observed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text NOT NULL,
	"hash" text NOT NULL,
	"caption" text,
	CONSTRAINT "evidence_hash" CHECK ("evidence"."hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "evidence_id" CHECK ("evidence"."id" = "evidence"."kind" || ':' || left("evidence"."hash", 16)),
	CONSTRAINT "evidence_kind" CHECK ("kind" in ('http_request', 'cookie', 'storage', 'dom_snapshot', 'screenshot', 'header', 'form', 'document', 'pass_diff', 'registry_record', 'answer', 'text'))
);
--> statement-breakpoint
CREATE TABLE "finding_evidence" (
	"finding_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"quote" text,
	CONSTRAINT "finding_evidence_finding_id_evidence_id_pk" PRIMARY KEY("finding_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"case_id" text NOT NULL,
	"scan_id" text,
	"type_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"binding" jsonb NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"area" text NOT NULL,
	"subject" jsonb,
	"remedy_id" text NOT NULL,
	"remedy_version" integer NOT NULL,
	"explanation" jsonb,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "findings_type" CHECK ("findings"."type_id" ~ '^[A-Z]{2,4}-[0-9]{2}$'),
	CONSTRAINT "findings_severity" CHECK ("severity" in ('blocking', 'serious', 'advisory')),
	CONSTRAINT "findings_status" CHECK ("status" in ('open', 'working', 'closed', 'regressed')),
	CONSTRAINT "findings_area" CHECK ("area" in ('Consent', 'Contracts', 'Security', 'Transfers', 'Observation', 'Notice', 'Recipients', 'Collection')),
	CONSTRAINT "findings_closed" CHECK (("findings"."status" = 'closed') = ("findings"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "jurisdictions" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"supported" boolean DEFAULT false NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	CONSTRAINT "jurisdictions_code" CHECK ("jurisdictions"."code" ~ '^(EU|[A-Z]{2})$')
);
--> statement-breakpoint
CREATE TABLE "processing_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"case_id" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"legal_basis" text,
	"data_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data_subjects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retention" text,
	"transfer" jsonb,
	"origin" text NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	CONSTRAINT "processing_activities_origin" CHECK ("origin" in ('derived', 'asserted', 'answered')),
	CONSTRAINT "processing_activities_confidence" CHECK ("processing_activities"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "remedies" (
	"id" text NOT NULL,
	"version" integer NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"finding_type_id" text NOT NULL,
	"kind" text NOT NULL,
	"jurisdictions" jsonb NOT NULL,
	"content" jsonb NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "remedies_id_version_pk" PRIMARY KEY("id","version"),
	CONSTRAINT "remedies_version" CHECK ("remedies"."version" >= 1),
	CONSTRAINT "remedies_kind" CHECK ("kind" in ('self_fix', 'generated_artefact', 'our_product', 'partner_alternative', 'no_solution')),
	CONSTRAINT "remedies_finding_type" CHECK ("remedies"."finding_type_id" ~ '^[A-Z]{2,4}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	CONSTRAINT "tenants_self" CHECK ("tenants"."tenant_id" = "tenants"."id")
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"case_id" text NOT NULL,
	"label" text NOT NULL,
	"legal_entity" jsonb,
	"jurisdiction" text NOT NULL,
	"parent_jurisdiction" text,
	"role" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"parent_vendor_id" text,
	"hosts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolution" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"transfer" jsonb,
	CONSTRAINT "vendors_role" CHECK ("role" in ('processor', 'sub_processor', 'joint_controller', 'independent_controller', 'unknown')),
	CONSTRAINT "vendors_resolution" CHECK ("resolution" in ('resolved', 'unresolved', 'ambiguous')),
	CONSTRAINT "vendors_level" CHECK ("vendors"."level" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app_meta" ADD COLUMN "tenant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "app_meta" ADD COLUMN "source_ref" text NOT NULL;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_jurisdiction_jurisdictions_code_fk" FOREIGN KEY ("jurisdiction") REFERENCES "jurisdictions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_jurisdiction_jurisdictions_code_fk" FOREIGN KEY ("jurisdiction") REFERENCES "jurisdictions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_remedy_fk" FOREIGN KEY ("remedy_id","remedy_version") REFERENCES "remedies"("id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_activities" ADD CONSTRAINT "processing_activities_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_parent_fk" FOREIGN KEY ("parent_vendor_id") REFERENCES "vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answers_case_question" ON "answers" USING btree ("case_id","question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_events_case_seq" ON "case_events" USING btree ("case_id","seq");--> statement-breakpoint
CREATE INDEX "case_events_tenant_idx" ON "case_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "cases_tenant_idx" ON "cases" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_tenant_hash" ON "evidence" USING btree ("tenant_id","hash");--> statement-breakpoint
CREATE INDEX "evidence_case_idx" ON "evidence" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_case_fingerprint" ON "findings" USING btree ("case_id","fingerprint");--> statement-breakpoint
CREATE INDEX "findings_tenant_idx" ON "findings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "processing_activities_case_idx" ON "processing_activities" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "vendors_case_idx" ON "vendors" USING btree ("case_id");
--> statement-breakpoint
-- case_events is append-only and evidence is immutable: the product rules as triggers,
-- not conventions. Both raise on UPDATE and DELETE.
CREATE OR REPLACE FUNCTION refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is %: % is not allowed', TG_TABLE_NAME, TG_ARGV[0], TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER case_events_append_only BEFORE UPDATE OR DELETE ON case_events
  FOR EACH ROW EXECUTE FUNCTION refuse_change('append-only');
--> statement-breakpoint
CREATE TRIGGER evidence_immutable BEFORE UPDATE OR DELETE ON evidence
  FOR EACH ROW EXECUTE FUNCTION refuse_change('immutable');
--> statement-breakpoint
-- Reference data: the jurisdictions the product knows, and which ones ship bindings (I-02).
INSERT INTO jurisdictions (code, name, supported, tenant_id, source_ref) VALUES
  ('EU', 'European Union', false, 'shared', 'migration:0001'),
  ('DK', 'Danmark', true, 'shared', 'migration:0001'),
  ('DE', 'Deutschland', true, 'shared', 'migration:0001')
ON CONFLICT (code) DO NOTHING;
