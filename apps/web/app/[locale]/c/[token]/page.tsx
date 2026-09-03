import { notFound } from 'next/navigation';
import { Text } from '@/components/Text';
import { loadCaseSummary } from '@/lib/case';
import { asLocale, t } from '@/lib/i18n';

// The case page for whoever holds the token (C-04): what is held, who can see it, and
// the two actions that prove the case is theirs.

export const dynamic = 'force-dynamic';

export default async function CasePage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale: localeParam, token } = await params;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const view = await loadCaseSummary(token);
  if (!view) notFound();
  const { counts } = view;
  const base = `/${locale}/c/${token}`;
  const who = view.claimed ? t(locale, 'case.who.claimed') : t(locale, 'case.who.unclaimed');
  return (
    <article className="case">
      <h1>
        <Text of={t(locale, 'case.heading')} /> {view.caseId}
      </h1>
      <p>
        <a href={`${base}/timeline`}>
          <Text of={t(locale, 'case.timeline')} />
        </a>
      </p>

      <section>
        <Text of={t(locale, 'case.holds')} as="h2" />
        <ul>
          <li>
            {counts.findings} <Text of={t(locale, 'case.holds.findings')} />
          </li>
          <li>
            {counts.evidence} <Text of={t(locale, 'case.holds.evidence')} />
          </li>
          <li>
            {counts.answers} <Text of={t(locale, 'case.holds.answers')} />
          </li>
          <li>
            {counts.vendors} <Text of={t(locale, 'case.holds.vendors')} />
          </li>
          <li>
            {counts.events} <Text of={t(locale, 'case.holds.events')} />
          </li>
        </ul>
      </section>

      <section>
        <Text of={t(locale, 'case.who')} as="h2" />
        <Text of={who} as="p" />
      </section>

      <section>
        <p>
          <a href={`${base}/export.json`} download={`${view.caseId}.json`}>
            <Text of={t(locale, 'case.export')} />
          </a>
        </p>
        <Text of={t(locale, 'case.export.note')} as="p" />
      </section>

      <section>
        <form method="post" action={`${base}/delete`}>
          <Text of={t(locale, 'case.delete.note')} as="p" />
          <label>
            <Text of={t(locale, 'case.delete.confirm')} />{' '}
            <input
              name="confirm"
              autoComplete="off"
              required
              pattern="[A-Z]{2}-[0-9]{2}-[A-Z0-9]{4}"
            />
          </label>{' '}
          <button type="submit">
            <Text of={t(locale, 'case.delete')} />
          </button>
        </form>
      </section>
    </article>
  );
}
