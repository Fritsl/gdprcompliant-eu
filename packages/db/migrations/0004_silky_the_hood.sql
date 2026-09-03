CREATE TABLE "case_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"case_id" text NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "case_events" DROP CONSTRAINT "case_events_type";--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "access_token" text DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "case_claims" ADD CONSTRAINT "case_claims_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_claims_case_idx" ON "case_claims" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_access_token" ON "cases" USING btree ("access_token");--> statement-breakpoint
CREATE INDEX "cases_domain_idx" ON "cases" USING btree ("tenant_id",("company"->>'domain'));--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_type" CHECK ("type" in ('case_opened', 'scan_started', 'scan_completed', 'scan_failed', 'finding_raised', 'finding_closed', 'finding_regressed', 'fix_verification_failed', 'check_undetermined', 'question_asked', 'question_answered', 'artefact_generated', 'artefact_published', 'colleague_invited', 'colleague_joined', 'reminder_sent', 'watch_run', 'meeting_requested', 'note_added', 'claim_rejected', 'claim_requested', 'case_claimed', 'case_expired', 'vendor_resolved'));--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_token_length" CHECK (length("cases"."access_token") >= 32);
--> statement-breakpoint
ALTER TABLE "case_claims" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "case_claims" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "case_claims_tenant" ON "case_claims" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "case_claims" TO gc_app;
--> statement-breakpoint
-- The one door to an unclaimed case (C-01): its token, resolved by a definer function
-- because the holder has no tenant context yet. An expired case is not found.
DO $$
BEGIN
  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION %I.case_by_token(token text)
    RETURNS TABLE (case_id text, tenant_id text, claimed_at timestamptz, expires_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = %I
    AS $body$
      SELECT id, tenant_id, claimed_at, expires_at FROM cases
      WHERE access_token = token AND (expires_at IS NULL OR expires_at > now())
    $body$;
  $fn$, current_schema(), current_schema());
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.case_by_token(text) TO gc_app', current_schema());
END
$$;
