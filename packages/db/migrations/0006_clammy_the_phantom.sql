CREATE TABLE "deletion_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"country" text NOT NULL,
	"year" integer NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	"requested_by" text NOT NULL,
	"rows_removed" integer NOT NULL,
	CONSTRAINT "deletion_audit_id" CHECK ("deletion_audit"."id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "deletion_audit_shared" CHECK ("deletion_audit"."tenant_id" = 'shared')
);
--> statement-breakpoint
ALTER TABLE "case_events" DROP CONSTRAINT "case_events_type";--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_type" CHECK ("type" in ('case_opened', 'scan_started', 'scan_completed', 'scan_failed', 'finding_raised', 'finding_closed', 'finding_regressed', 'fix_verification_failed', 'check_undetermined', 'question_asked', 'question_answered', 'artefact_generated', 'artefact_published', 'colleague_invited', 'colleague_joined', 'reminder_sent', 'watch_run', 'meeting_requested', 'note_added', 'claim_rejected', 'claim_requested', 'case_claimed', 'case_expired', 'export_produced', 'deletion_requested', 'vendor_resolved'));
--> statement-breakpoint
ALTER TABLE "deletion_audit" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deletion_audit" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "deletion_audit_tenant" ON "deletion_audit" USING (tenant_id = 'shared' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT ON "deletion_audit" TO gc_app;
--> statement-breakpoint
-- The append-only and immutable triggers let a DELETE through only while the session
-- names the case being erased (C-04). delete_case sets that for its own duration.
CREATE OR REPLACE FUNCTION refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.hard_delete', true), '') <> ''
     AND current_setting('app.hard_delete', true) = OLD.case_id THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is %: % is not allowed', TG_TABLE_NAME, TG_ARGV[0], TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
-- The hard delete (C-04): every row of the case in dependency order, the tenant when
-- nothing else is left in it, and the anonymous stub. Runs as its definer.
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
      DELETE FROM demand_entries WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM case_events WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM cases WHERE id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      PERFORM set_config('app.hard_delete', '', true);
      IF NOT EXISTS (SELECT 1 FROM cases WHERE tenant_id = v_tenant) THEN
        DELETE FROM tenants WHERE id = v_tenant;
      END IF;
      INSERT INTO deletion_audit (id, tenant_id, source_ref, country, year, deleted_at, requested_by, rows_removed)
      VALUES (p_stub_id, 'shared', 'delete_case', left(p_case_id, 2), 2000 + substr(p_case_id, 4, 2)::int, p_at, p_requested_by, n);
      RETURN n;
    END
    $body$;
  $fn$, current_schema(), current_schema());
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.delete_case(text, text, text, timestamptz) TO gc_app', current_schema());
END
$$;
