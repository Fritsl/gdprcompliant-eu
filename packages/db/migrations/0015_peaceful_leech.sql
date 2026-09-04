CREATE TABLE "graph_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"case_id" text NOT NULL,
	"kind" text NOT NULL,
	"from_node" text NOT NULL,
	"to_node" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin" text NOT NULL,
	"confidence" real NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asserted_by" text,
	"answer_id" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "graph_edges_kind" CHECK ("kind" in ('has_purpose', 'processes', 'rests_on', 'shared_with', 'transfers_via', 'carries_risk', 'mitigated_by', 'contradicts', 'supersedes')),
	CONSTRAINT "graph_edges_origin" CHECK ("origin" in ('derived', 'asserted', 'answered')),
	CONSTRAINT "graph_edges_confidence" CHECK ("graph_edges"."confidence" between 0 and 1),
	CONSTRAINT "graph_edges_evidence" CHECK (jsonb_typeof("graph_edges"."evidence") = 'array'),
	CONSTRAINT "graph_edges_provenance" CHECK (("graph_edges"."origin" <> 'derived' OR jsonb_array_length("graph_edges"."evidence") >= 1) AND ("graph_edges"."origin" <> 'asserted' OR coalesce("graph_edges"."asserted_by", '') <> '') AND ("graph_edges"."origin" <> 'answered' OR coalesce("graph_edges"."answer_id", '') <> '')),
	CONSTRAINT "graph_edges_ends" CHECK ("graph_edges"."from_node" <> "graph_edges"."to_node")
);
--> statement-breakpoint
CREATE TABLE "graph_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"case_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin" text NOT NULL,
	"confidence" real NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asserted_by" text,
	"answer_id" text,
	"at" timestamp with time zone NOT NULL,
	"superseded_by" text,
	CONSTRAINT "graph_nodes_kind" CHECK ("kind" in ('activity', 'data_category', 'purpose', 'legal_basis', 'vendor', 'transfer', 'risk', 'control')),
	CONSTRAINT "graph_nodes_origin" CHECK ("origin" in ('derived', 'asserted', 'answered')),
	CONSTRAINT "graph_nodes_confidence" CHECK ("graph_nodes"."confidence" between 0 and 1),
	CONSTRAINT "graph_nodes_evidence" CHECK (jsonb_typeof("graph_nodes"."evidence") = 'array'),
	CONSTRAINT "graph_nodes_provenance" CHECK (("graph_nodes"."origin" <> 'derived' OR jsonb_array_length("graph_nodes"."evidence") >= 1) AND ("graph_nodes"."origin" <> 'asserted' OR coalesce("graph_nodes"."asserted_by", '') <> '') AND ("graph_nodes"."origin" <> 'answered' OR coalesce("graph_nodes"."answer_id", '') <> ''))
);
--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_from_node_graph_nodes_id_fk" FOREIGN KEY ("from_node") REFERENCES "graph_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_to_node_graph_nodes_id_fk" FOREIGN KEY ("to_node") REFERENCES "graph_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "graph_edges_unique" ON "graph_edges" USING btree ("from_node","to_node","kind");--> statement-breakpoint
CREATE INDEX "graph_edges_case_idx" ON "graph_edges" USING btree ("case_id","kind");--> statement-breakpoint
CREATE INDEX "graph_nodes_case_idx" ON "graph_nodes" USING btree ("case_id","kind","key");
--> statement-breakpoint
ALTER TABLE "graph_nodes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "graph_nodes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "graph_nodes_tenant" ON "graph_nodes" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "graph_nodes" TO gc_app;
--> statement-breakpoint
-- A fact is superseded, never deleted; only the hard delete (C-04) removes rows.
CREATE TRIGGER "graph_nodes_no_delete" BEFORE DELETE ON "graph_nodes" FOR EACH ROW EXECUTE FUNCTION refuse_change('kept');
--> statement-breakpoint
ALTER TABLE "graph_edges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "graph_edges" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "graph_edges_tenant" ON "graph_edges" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "graph_edges" TO gc_app;
--> statement-breakpoint
-- A fact is superseded, never deleted; only the hard delete (C-04) removes rows.
CREATE TRIGGER "graph_edges_no_delete" BEFORE DELETE ON "graph_edges" FOR EACH ROW EXECUTE FUNCTION refuse_change('kept');
--> statement-breakpoint
-- delete_case (C-04) now takes the case graph with the case: edges first, then nodes.
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
      DELETE FROM graph_edges WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
      DELETE FROM graph_nodes WHERE case_id = p_case_id;
      GET DIAGNOSTICS removed = ROW_COUNT; n := n + removed;
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
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.delete_case(text, text, text, timestamptz) TO gc_app', current_schema());
END
$$;
