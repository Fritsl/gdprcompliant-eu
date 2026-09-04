import { notFound } from 'next/navigation';
import { ScanProgress, type StageRow } from '@/components/ScanProgress';
import { Text } from '@/components/Text';
import { asLocale, t } from '@/lib/i18n';
import { readScan } from '@/lib/scan';
import { SCAN_STAGES } from '@gc/db';

// Watching a scan (U-02): the stages the worker has marked, rendered on the server, and
// kept current from the event stream once the page is up.

export const dynamic = 'force-dynamic';

export default async function ScanPage({
  params,
}: {
  params: Promise<{ locale: string; job: string }>;
}) {
  const { locale: localeParam, job } = await params;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const view = await readScan(job);
  if (!view) notFound();

  // Every key literally, so the message audit sees each one asked for.
  const labels: Record<string, string> = {
    opening: t(locale, 'scan.stage.opening').text,
    'first-load': t(locale, 'scan.stage.firstLoad').text,
    banner: t(locale, 'scan.stage.banner').text,
    refusing: t(locale, 'scan.stage.refusing').text,
    'after-refusal': t(locale, 'scan.stage.afterRefusal').text,
    accepting: t(locale, 'scan.stage.accepting').text,
    policy: t(locale, 'scan.stage.policy').text,
    recipients: t(locale, 'scan.stage.recipients').text,
    security: t(locale, 'scan.stage.security').text,
    'writing-up': t(locale, 'scan.stage.writingUp').text,
  };
  const marks: Record<string, string> = {
    ok: t(locale, 'scan.mark.ok').text,
    undet: t(locale, 'scan.mark.undet').text,
    na: t(locale, 'scan.mark.na').text,
    skip: t(locale, 'scan.mark.skip').text,
    fail: t(locale, 'scan.mark.fail').text,
  };
  const outcomes = {
    case: {
      heading: t(locale, 'scan.outcome.case.heading').text,
      body: t(locale, 'scan.outcome.case.body').text,
      cta: t(locale, 'scan.outcome.case.cta').text,
    },
    no_banner_needed: {
      heading: t(locale, 'scan.outcome.noBanner.heading').text,
      body: t(locale, 'scan.outcome.noBanner.body').text,
      cta: t(locale, 'scan.outcome.noBanner.cta').text,
    },
    no_refusal: {
      heading: t(locale, 'scan.outcome.noRefusal.heading').text,
      body: t(locale, 'scan.outcome.noRefusal.body').text,
      cta: t(locale, 'scan.outcome.noRefusal.cta').text,
    },
    unreachable: {
      heading: t(locale, 'scan.outcome.unreachable.heading').text,
      body: t(locale, 'scan.outcome.unreachable.body').text,
      cta: t(locale, 'scan.outcome.unreachable.cta').text,
    },
  };
  const byStage = new Map(view.progress.stages.map((s) => [s.stage, s]));
  const rows: StageRow[] = SCAN_STAGES.map((stage) => {
    const s = byStage.get(stage);
    return {
      stage,
      label: labels[stage]!,
      mark: (s?.mark ?? 'todo') as StageRow['mark'],
      ...(s?.detail ? { detail: s.detail } : {}),
    };
  });
  const failedOutright = view.failed && !view.progress.outcome;
  return (
    <article className="scanning">
      <p className="eyebrow">{view.domain}</p>
      <Text of={t(locale, 'scan.heading')} as="h1" />
      <ScanProgress
        initial={{
          rows,
          done: view.done,
          ...(failedOutright ? { outcome: 'unreachable' } : {}),
          ...(view.progress.outcome ? { outcome: view.progress.outcome } : {}),
          ...(view.progress.caseToken ? { caseToken: view.progress.caseToken } : {}),
        }}
        eventsUrl={`/${locale}/scan/${job}/events`}
        labels={labels}
        marks={marks}
        outcomes={outcomes}
        casePath={`/${locale}/c/`}
        frontHref={`/${locale}`}
      />
      {!view.done ? (
        <p className="muted">
          <Text of={t(locale, 'scan.hint')} />
        </p>
      ) : null}
    </article>
  );
}
