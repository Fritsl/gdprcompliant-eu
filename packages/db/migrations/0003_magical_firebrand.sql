CREATE TABLE "demand_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"case_id" text NOT NULL,
	"finding_type_id" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"gap" text NOT NULL,
	"cause" text NOT NULL,
	"answer" text NOT NULL,
	"sector" text,
	"sector_code" text,
	"headcount_band" text,
	"country" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "demand_entries_answer" CHECK ("answer" in ('none', 'partial', 'ours'))
);
--> statement-breakpoint
ALTER TABLE "demand_entries" ADD CONSTRAINT "demand_entries_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demand_entries_type_idx" ON "demand_entries" USING btree ("finding_type_id","jurisdiction");--> statement-breakpoint
CREATE INDEX "demand_entries_seen_idx" ON "demand_entries" USING btree ("seen_at");
--> statement-breakpoint
ALTER TABLE "demand_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "demand_entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "demand_entries_tenant" ON "demand_entries" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "demand_entries" TO gc_app;
--> statement-breakpoint
-- The only cross-tenant read of the ledger (R-05): groups of at least k distinct
-- tenants, at three grains, counts and dates only. Runs as its definer, pinned to the
-- schema it was created in. Purpose and retention: docs/decisions/demand-ledger.md.
DO $$
BEGIN
  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION %I.demand_ranked(k integer)
    RETURNS TABLE (
      finding_type_id text, jurisdiction text, country text, sector text, headcount_band text,
      tenants bigint, cases bigint, entries bigint, first_seen_at timestamptz, last_seen_at timestamptz
    )
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = %I
    AS $body$
      WITH rollup AS (
        SELECT finding_type_id, jurisdiction, NULL::text AS country, NULL::text AS sector, NULL::text AS headcount_band,
               count(DISTINCT tenant_id) AS tenants, count(DISTINCT case_id) AS cases, count(*) AS entries,
               min(seen_at) AS first_seen_at, max(seen_at) AS last_seen_at
        FROM demand_entries GROUP BY 1, 2 HAVING count(DISTINCT tenant_id) >= k
      ), by_sector AS (
        SELECT finding_type_id, jurisdiction, country, sector, NULL::text AS headcount_band,
               count(DISTINCT tenant_id), count(DISTINCT case_id), count(*), min(seen_at), max(seen_at)
        FROM demand_entries GROUP BY 1, 2, 3, 4 HAVING count(DISTINCT tenant_id) >= k
      ), detail AS (
        SELECT finding_type_id, jurisdiction, country, sector, headcount_band,
               count(DISTINCT tenant_id), count(DISTINCT case_id), count(*), min(seen_at), max(seen_at)
        FROM demand_entries GROUP BY 1, 2, 3, 4, 5 HAVING count(DISTINCT tenant_id) >= k
      )
      SELECT * FROM rollup
      UNION ALL SELECT * FROM by_sector
      UNION ALL SELECT * FROM detail
      ORDER BY tenants DESC, entries DESC, finding_type_id, jurisdiction,
               country NULLS FIRST, sector NULLS FIRST, headcount_band NULLS FIRST
    $body$;
  $fn$, current_schema(), current_schema());
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.demand_ranked(integer) TO gc_app', current_schema());
END
$$;
