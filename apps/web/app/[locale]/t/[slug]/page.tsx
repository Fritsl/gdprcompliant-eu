import { notFound } from 'next/navigation';
import { Text } from '@/components/Text';
import { loadTrustPage } from '@/lib/case';
import { asLocale, t } from '@/lib/i18n';

// The public progress page (U-05): what a company links from its own site. Dated work
// in progress: what was fixed and when, how many things are open, when we last looked.
// Never an open finding, never a verdict, never a seal. The call to action at the end is
// the way in for the next company.

export const dynamic = 'force-dynamic';

// Dates the European way; English here is the English of the Union, not of the US.
const day = (iso: string, locale: string) =>
  new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, {
    dateStyle: 'long',
    timeZone: 'Europe/Copenhagen',
  }).format(new Date(iso));

export default async function TrustPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale: localeParam, slug } = await params;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const view = await loadTrustPage(slug, locale);
  if (!view) notFound();
  const openText =
    view.openCount === 0
      ? t(locale, 'trust.open.none')
      : view.openCount === 1
        ? t(locale, 'trust.open.one')
        : t(locale, 'trust.open.many');
  return (
    <article className="screen trust" data-case={view.caseId} data-open={view.openCount}>
      <p className="eyebrow">{view.domain}</p>
      <div className="trust-card">
        <div className="trust-h">
          <h1>
            {view.name} · <Text of={t(locale, 'trust.headline')} />
          </h1>
          <div className="meta">
            <span data-last-checked="">
              {view.lastCheckedAt ? (
                <>
                  <Text of={t(locale, 'trust.lastChecked')} />{' '}
                  <time dateTime={view.lastCheckedAt}>{day(view.lastCheckedAt, locale)}</time>
                </>
              ) : (
                <Text of={t(locale, 'trust.notCheckedYet')} />
              )}
            </span>
            <span>
              <Text of={t(locale, 'trust.published')} />{' '}
              <time dateTime={view.publishedAt}>{day(view.publishedAt, locale)}</time>
            </span>
            <span>
              <Text of={t(locale, 'trust.case')} /> {view.caseId}
            </span>
            <span>
              <Text of={t(locale, 'trust.checkedBy')} />
            </span>
          </div>
        </div>
        <div className="trust-st">
          <Text of={t(locale, 'trust.statement')} />
        </div>
        {view.fixed.length === 0 ? (
          <div className="trust-st">
            <Text of={t(locale, 'trust.nothingYet')} />
          </div>
        ) : (
          <ul className="trust-list" aria-label={t(locale, 'trust.fixed').text}>
            {view.fixed.map((f) => (
              <li key={f.findingId}>
                <span className="tick">✓</span>
                <span>{f.title}</span>
                <time dateTime={f.closedAt}>{day(f.closedAt, locale)}</time>
              </li>
            ))}
          </ul>
        )}
        <div className="trust-f">
          <span className="open" data-open-note="">
            {view.openCount > 0 ? <>{view.openCount} </> : null}
            <Text of={openText} />
          </span>
          <a className="btn" href={`/${locale}`} data-cta="">
            <Text of={t(locale, 'trust.cta')} />
          </a>
        </div>
      </div>
    </article>
  );
}
