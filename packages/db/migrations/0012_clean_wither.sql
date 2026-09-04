CREATE TABLE "artefacts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"case_id" text NOT NULL,
	"kind" text NOT NULL,
	"locale" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content" text NOT NULL,
	"hash" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"generated_by" jsonb NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_by" jsonb,
	"signed_version" integer,
	"signed_hash" text,
	"published_at" timestamp with time zone,
	"published_url" text,
	CONSTRAINT "artefacts_kind" CHECK ("kind" in ('privacy_policy', 'cookie_declaration', 'processing_agreement', 'processing_register', 'sub_processor_list', 'retention_schedule', 'evidence_pack', 'status_report')),
	CONSTRAINT "artefacts_status" CHECK ("status" in ('draft', 'signed', 'published')),
	CONSTRAINT "artefacts_hash" CHECK ("artefacts"."hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "artefacts_signature" CHECK (("artefacts"."status" = 'draft') = ("artefacts"."signed_at" IS NULL) AND ("artefacts"."status" = 'draft') = ("artefacts"."signed_by" IS NULL)),
	CONSTRAINT "artefacts_published" CHECK (("artefacts"."status" = 'published') = ("artefacts"."published_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "case_events" DROP CONSTRAINT "case_events_type";--> statement-breakpoint
ALTER TABLE "artefacts" ADD CONSTRAINT "artefacts_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artefacts_case_kind" ON "artefacts" USING btree ("case_id","kind");--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_type" CHECK ("type" in ('case_opened', 'scan_started', 'scan_completed', 'scan_failed', 'finding_raised', 'finding_closed', 'finding_regressed', 'fix_verification_failed', 'check_undetermined', 'question_asked', 'question_answered', 'artefact_generated', 'artefact_signed', 'artefact_published', 'colleague_invited', 'colleague_joined', 'reminder_sent', 'invitation_revoked', 'watch_run', 'meeting_requested', 'note_added', 'locale_overridden', 'claim_rejected', 'claim_requested', 'case_claimed', 'case_expired', 'export_produced', 'deletion_requested', 'vendor_resolved'));
--> statement-breakpoint
ALTER TABLE "artefacts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "artefacts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "artefacts_tenant" ON "artefacts" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "artefacts" TO gc_app;
--> statement-breakpoint
-- delete_case (C-04) now takes the documents with the case.
DO $$
BEGIN
  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION %I.delete_case(p_case_id text, p_requested_by text, p_stub_id text, p_at timestamptz)
    RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = %I
    AS $body$
    DECLARE
      n integer := 0;
      removed integer;
      v_tenant text;
    BEGIN
      SELECT tenant_id INTO v_tenant FROM cases WHERE id = p_case_id;
      IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'no case %%', p_case_id;
      END IF;
      PERFORM set_config('app.hard_delete', p_case_id, true);
      DELETE FROM finding_evidence WHERE finding_id IN (SELECT id FROM findings WHERE case_id = p_case_id);
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM findings WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM evidence WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM answers WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM vendors WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM processing_activities WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM case_claims WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM case_members WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM mail_outbox WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM claim_verdicts WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM artefacts WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM demand_entries WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM case_events WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM cases WHERE id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      PERFORM set_config('app.hard_delete', '', true);
      IF NOT EXISTS (SELECT 1 FROM cases WHERE tenant_id = v_tenant) THEN
        DELETE FROM tenants WHERE id = v_tenant;
        GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      END IF;
      INSERT INTO deletion_audit (id, tenant_id, source_ref, country, year, deleted_at, requested_by, rows_removed)
      VALUES (p_stub_id, 'shared', 'delete_case', left(p_case_id, 2), 2000 + substr(p_case_id, 4, 2)::int, p_at, p_requested_by, n);
      RETURN n;
    END
    $body$;
  $fn$, current_schema(), current_schema());
END
$$;
