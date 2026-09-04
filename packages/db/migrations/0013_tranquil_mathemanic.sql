ALTER TABLE "case_events" DROP CONSTRAINT "case_events_type";--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "trust_slug" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "trust_published_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "cases_trust_slug" ON "cases" USING btree ("trust_slug");--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_type" CHECK ("type" in ('case_opened', 'scan_started', 'scan_completed', 'scan_failed', 'finding_raised', 'finding_closed', 'finding_regressed', 'fix_verification_failed', 'check_undetermined', 'question_asked', 'question_answered', 'artefact_generated', 'artefact_signed', 'artefact_published', 'colleague_invited', 'colleague_joined', 'reminder_sent', 'invitation_revoked', 'watch_run', 'meeting_requested', 'note_added', 'locale_overridden', 'claim_rejected', 'claim_requested', 'case_claimed', 'case_expired', 'export_produced', 'deletion_requested', 'vendor_resolved', 'trust_published', 'trust_unpublished'));--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_trust_slug" CHECK ("cases"."trust_slug" is null or "cases"."trust_slug" ~ '^[a-f0-9]{16}$');
--> statement-breakpoint
-- The public progress page (U-05), read by its slug without a tenant context. The
-- function hands out only what the page shows: the company, when it was published and
-- last checked, how many findings are open (a number, never which), and what was fixed
-- and when. An unpublished page is not found.
DO $$
BEGIN
  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION %I.trust_page(slug text)
    RETURNS TABLE (
      case_id text,
      company jsonb,
      locale text,
      jurisdiction text,
      published_at timestamptz,
      last_checked_at timestamptz,
      open_count int,
      fixed jsonb
    )
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = %I
    AS $body$
      SELECT
        c.id,
        c.company,
        c.locale,
        c.jurisdiction,
        c.trust_published_at,
        (SELECT max(e.at) FROM case_events e WHERE e.case_id = c.id AND e.type = 'scan_completed'),
        (SELECT count(*)::int FROM findings f WHERE f.case_id = c.id AND f.status <> 'closed'),
        COALESCE(
          (SELECT jsonb_agg(
             jsonb_build_object(
               'findingId', f.id,
               'typeId', f.type_id,
               'remedyId', f.remedy_id,
               'remedyVersion', f.remedy_version,
               'closedAt', f.closed_at
             ) ORDER BY f.closed_at DESC, f.type_id
           )
           FROM findings f WHERE f.case_id = c.id AND f.status = 'closed' AND f.closed_at IS NOT NULL),
          '[]'::jsonb
        )
      FROM cases c
      WHERE c.trust_slug = slug AND c.trust_published_at IS NOT NULL
    $body$;
  $fn$, current_schema(), current_schema());
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.trust_page(text) TO gc_app', current_schema());
END
$$;
