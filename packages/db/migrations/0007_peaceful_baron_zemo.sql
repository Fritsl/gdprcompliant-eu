CREATE TABLE "case_members" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"case_id" text NOT NULL,
	"role" text NOT NULL,
	"email" text NOT NULL,
	"invite_token" text NOT NULL,
	"invited_at" timestamp with time zone NOT NULL,
	"joined_at" timestamp with time zone,
	"granted_full" boolean DEFAULT false NOT NULL,
	CONSTRAINT "case_members_role" CHECK ("role" in ('marketing', 'it', 'hr', 'finance')),
	CONSTRAINT "case_members_token_length" CHECK (length("case_members"."invite_token") >= 32)
);
--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_members_invite" ON "case_members" USING btree ("invite_token");--> statement-breakpoint
CREATE UNIQUE INDEX "case_members_case_email" ON "case_members" USING btree ("case_id","email");--> statement-breakpoint
CREATE INDEX "case_members_case_idx" ON "case_members" USING btree ("case_id");
--> statement-breakpoint
ALTER TABLE "case_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "case_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "case_members_tenant" ON "case_members" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "case_members" TO gc_app;
--> statement-breakpoint
-- The one door to a colleague's list (P-01): their invitation token, resolved by a
-- definer function because the holder has no tenant context yet.
DO $$
BEGIN
  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION %I.member_by_invite(token text)
    RETURNS TABLE (member_id text, case_id text, tenant_id text, role text, joined_at timestamptz, granted_full boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = %I
    AS $body$
      SELECT m.id, m.case_id, m.tenant_id, m.role, m.joined_at, m.granted_full
      FROM case_members m JOIN cases c ON c.id = m.case_id
      WHERE m.invite_token = token AND (c.expires_at IS NULL OR c.expires_at > now())
    $body$;
  $fn$, current_schema(), current_schema());
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.member_by_invite(text) TO gc_app', current_schema());
END
$$;
--> statement-breakpoint
-- delete_case (C-04) now takes the members with the case.
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
END
$$;
