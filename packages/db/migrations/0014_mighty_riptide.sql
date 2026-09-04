CREATE TABLE "case_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"case_id" text NOT NULL,
	"kind" text DEFAULT 'upward' NOT NULL,
	"token" text NOT NULL,
	"audience" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '90 days' NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "case_shares_kind" CHECK ("kind" in ('upward')),
	CONSTRAINT "case_shares_token_length" CHECK (length("case_shares"."token") >= 32)
);
--> statement-breakpoint
ALTER TABLE "case_events" DROP CONSTRAINT "case_events_type";--> statement-breakpoint
ALTER TABLE "case_shares" ADD CONSTRAINT "case_shares_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_shares_token" ON "case_shares" USING btree ("token");--> statement-breakpoint
CREATE INDEX "case_shares_case_idx" ON "case_shares" USING btree ("case_id");--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_type" CHECK ("type" in ('case_opened', 'scan_started', 'scan_completed', 'scan_failed', 'finding_raised', 'finding_closed', 'finding_regressed', 'fix_verification_failed', 'check_undetermined', 'question_asked', 'question_answered', 'artefact_generated', 'artefact_signed', 'artefact_published', 'colleague_invited', 'colleague_joined', 'reminder_sent', 'invitation_revoked', 'watch_run', 'meeting_requested', 'note_added', 'locale_overridden', 'claim_rejected', 'claim_requested', 'case_claimed', 'case_expired', 'export_produced', 'deletion_requested', 'vendor_resolved', 'trust_published', 'trust_unpublished', 'share_created', 'share_revoked'));
--> statement-breakpoint
ALTER TABLE "case_shares" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "case_shares" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "case_shares_tenant" ON "case_shares" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "case_shares" TO gc_app;
--> statement-breakpoint
-- A share link resolves without a tenant context (U-07): the reader has none. Only a live
-- link on a live case answers; revoked, expired and unknown all answer nothing.
DO $$
BEGIN
  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION %I.share_by_token(p_token text)
    RETURNS TABLE (share_id text, case_id text, tenant_id text, kind text, audience text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = %I
    AS $body$
      SELECT s.id, s.case_id, s.tenant_id, s.kind, s.audience
      FROM case_shares s JOIN cases c ON c.id = s.case_id
      WHERE s.token = p_token
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND (c.expires_at IS NULL OR c.expires_at > now())
    $body$;
  $fn$, current_schema(), current_schema());
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.share_by_token(text) TO gc_app', current_schema());
END
$$;
--> statement-breakpoint
-- delete_case (C-04) now takes the share links with the case.
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
      DELETE FROM case_shares WHERE case_id = p_case_id;
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
