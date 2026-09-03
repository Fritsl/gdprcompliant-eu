-- Row-level security on every table (F-05). The app connects as, or switches to, the
-- role gc_app, which is subject to these policies; a row is visible or writable only
-- when its tenant_id equals the current tenant context, set per transaction with
-- set_config('app.tenant_id', ..., true). With no context the comparison is null and
-- every table is empty. Reference data (tenant_id = 'shared') is readable by everyone
-- and writable by nobody through the app role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gc_app') THEN
    CREATE ROLE gc_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO gc_app', current_schema());
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO gc_app', current_schema());
  EXECUTE format('GRANT gc_app TO %I', current_user);
END
$$;
--> statement-breakpoint
ALTER TABLE "answers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "answers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "answers_tenant" ON "answers" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "app_meta" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app_meta" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app_meta_tenant" ON "app_meta" USING (tenant_id = 'shared' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "case_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "case_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "case_events_tenant" ON "case_events" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "cases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "cases_tenant" ON "cases" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "evidence_tenant" ON "evidence" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "finding_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "finding_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "finding_evidence_tenant" ON "finding_evidence" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "findings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "findings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "findings_tenant" ON "findings" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "jurisdictions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "jurisdictions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "jurisdictions_tenant" ON "jurisdictions" USING (tenant_id = 'shared' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "processing_activities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "processing_activities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "processing_activities_tenant" ON "processing_activities" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "remedies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "remedies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "remedies_tenant" ON "remedies" USING (tenant_id = 'shared' OR tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenants_tenant" ON "tenants" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "vendors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "vendors" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "vendors_tenant" ON "vendors" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
