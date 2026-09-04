import { notFound } from 'next/navigation';
import { Text } from '@/components/Text';
import { loadUpward } from '@/lib/case';
import { asLocale, t } from '@/lib/i18n';

// The upward view (U-07): one screen for someone above the case. How far along it is,
// desk by desk, what has been fixed and when, how much is open by weight. Progress, never
// a grade; no evidence, no prompts, nothing to act on. The link it lives at is the case
// holder's to revoke.

export const dynamic = 'force-dynamic';

const FIXED_SHOWN = 3;

const day = (iso: string, locale: string) =>
  new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, {
    dateStyle: 'medium',
    timeZone: 'Europe/Copenhagen',
  }).format(new Date(iso));

export default async function UpwardPage({
  params,
}: {
  params: Promise<{ locale: string; share: string }>;
}) {
  const { locale: localeParam, share } = await params;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const view = await loadUpward(share, locale);
  if (!view) notFound();
  const roleLabel = {
    marketing: t(locale, 'progress.role.marketing'),
    it: t(locale, 'progress.role.it'),
    hr: t(locale, 'progress.role.hr'),
    finance: t(locale, 'progress.role.finance'),
  };
  const severityLabel = {
    blocking: t(locale, 'severity.blocking'),
    serious: t(locale, 'severity.serious'),
    advisory: t(locale, 'severity.advisory'),
  };
  const total = view.done + view.open;
  const width = total === 0 ? 100 : Math.round((view.done / total) * 100);
  const shown = view.fixed.slice(0, FIXED_SHOWN);
  const more = view.fixed.length - shown.length;
  return (
    <article
      className="screen narrow upward"
      data-case={view.caseId}
      data-done={view.done}
      data-open={view.open}
    >
      <header className="plan-top">
        <span className="caseid">{view.caseId}</span>
        <span className="plan-dom">{view.domain}</span>
        <span className="plan-saved">
          <Text of={t(locale, 'upward.for')} /> {view.audience || view.domain}
        </span>
      </header>
      <h1 className="plan-lead">
        {view.done} <Text of={t(locale, 'case.progress.of')} /> {total}{' '}
        <Text of={t(locale, 'case.progress.done')} />
      </h1>
      <div className="plan-prog">
        <div className="pp-bar" role="progressbar" aria-valuenow={view.done} aria-valuemax={total}>
          <i style={{ width: `${width}%` }} />
        </div>
        <span className="pp-txt">
          {view.lastCheckedAt ? (
            <>
              <Text of={t(locale, 'trust.lastChecked')} /> {day(view.lastCheckedAt, locale)}
            </>
          ) : (
            <Text of={t(locale, 'trust.notCheckedYet')} />
          )}
        </span>
      </div>
      <p className="plan-sub" data-open-by-severity="">
        {view.open === 0 ? (
          <Text of={t(locale, 'trust.open.none')} />
        ) : (
          (['blocking', 'serious', 'advisory'] as const)
            .filter((s) => view.openBySeverity[s] > 0)
            .map((s, i) => (
              <span key={s}>
                {i > 0 ? ' · ' : ''}
                {view.openBySeverity[s]} <Text of={severityLabel[s]} />
              </span>
            ))
        )}{' '}
        <Text of={t(locale, 'upward.open')} />
      </p>

      <div className="roles" data-desks="">
        {view.roles.map((r) => (
          <div className="role" key={r.role} data-role={r.role}>
            <div className="who">
              <Text of={roleLabel[r.role]} />
            </div>
            <h4>
              {r.done} <Text of={t(locale, 'case.progress.of')} /> {r.done + r.open}{' '}
              <Text of={t(locale, 'case.progress.done')} />
            </h4>
          </div>
        ))}
      </div>

      <section className="plan-foot">
        <Text of={t(locale, 'upward.fixed')} as="h2" />
        {shown.length === 0 ? (
          <Text of={t(locale, 'trust.nothingYet')} as="p" />
        ) : (
          <ul className="trust-list" data-fixed="">
            {shown.map((f) => (
              <li key={f.findingId}>
                <span className="tick">✓</span>
                <span>{f.title}</span>
                <time dateTime={f.closedAt}>{day(f.closedAt, locale)}</time>
              </li>
            ))}
          </ul>
        )}
        {more > 0 ? (
          <p className="muted">
            + {more} <Text of={t(locale, 'upward.more')} />
          </p>
        ) : null}
        <p className="plan-own">
          <Text of={t(locale, 'upward.generated')} /> {day(view.generatedAt, locale)} ·{' '}
          <Text of={t(locale, 'upward.revocable')} />
        </p>
      </section>
    </article>
  );
}
