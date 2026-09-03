CREATE TABLE "claim_verdicts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"case_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"claim_kind" text NOT NULL,
	"statement" text NOT NULL,
	"verdict" text NOT NULL,
	"checks" jsonb NOT NULL,
	"reason" text,
	"at" timestamp with time zone NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	CONSTRAINT "claim_verdicts_verdict" CHECK ("verdict" in ('accepted', 'rejected')),
	CONSTRAINT "claim_verdicts_kind" CHECK ("claim_kind" in ('observation', 'legal', 'drafting')),
	CONSTRAINT "claim_verdicts_reason" CHECK ("claim_verdicts"."verdict" = 'accepted' OR coalesce("claim_verdicts"."reason", '') <> ''),
	CONSTRAINT "claim_verdicts_checks" CHECK (jsonb_typeof("claim_verdicts"."checks") = 'array' AND jsonb_array_length("claim_verdicts"."checks") >= 1)
);
--> statement-breakpoint
ALTER TABLE "claim_verdicts" ADD CONSTRAINT "claim_verdicts_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_verdicts_case_idx" ON "claim_verdicts" USING btree ("case_id","at");--> statement-breakpoint
CREATE INDEX "claim_verdicts_queue_idx" ON "claim_verdicts" USING btree ("verdict","reviewed_at","at");
--> statement-breakpoint
ALTER TABLE "claim_verdicts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "claim_verdicts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "claim_verdicts_tenant" ON "claim_verdicts" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "claim_verdicts" TO gc_app;
--> statement-breakpoint
-- The internal review queue (A-07): rejections nobody has looked at yet, across every
-- tenant, newest first. Read by operators, never by a customer page.
DO $$
BEGIN
  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION %I.review_queue(k integer)
    RETURNS TABLE (id text, tenant_id text, case_id text, claim_id text, claim_kind text, statement text, reason text, at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = %I
    AS $body$
      SELECT id, tenant_id, case_id, claim_id, claim_kind, statement, reason, at
      FROM claim_verdicts
      WHERE verdict = 'rejected' AND reviewed_at IS NULL
      ORDER BY at DESC, id
      LIMIT greatest(k, 0)
    $body$;
  $fn$, current_schema(), current_schema());
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.review_queue(integer) TO gc_app', current_schema());
END
$$;
--> statement-breakpoint
-- delete_case (C-04) now takes the verdicts with the case.
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
