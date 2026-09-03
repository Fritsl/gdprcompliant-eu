import { notFound } from 'next/navigation';
import { timelineModel } from '@gc/artefacts';
import { Text } from '@/components/Text';
import { loadCaseByToken } from '@/lib/case';
import { asLocale, t } from '@/lib/i18n';

// The accountability record (C-02), read by whoever holds the case's token.

export const dynamic = 'force-dynamic';

export default async function Timeline({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale: localeParam, token } = await params;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const view = await loadCaseByToken(token);
  if (!view) notFound();
  const model = timelineModel(view.caseId, view.events, { locale });
  return (
    <article className="timeline">
      <h1>
        <Text of={t(locale, 'timeline.heading')} /> · {view.caseId}
      </h1>
      <Text of={t(locale, 'timeline.lead')} as="p" />
      <p>
        <a href={`/${locale}/c/${token}/timeline.pdf`} download={`${view.caseId}-timeline.pdf`}>
          <Text of={t(locale, 'timeline.download')} />
        </a>
      </p>
      <ol className="timeline-list">
        {model.entries.map((e) => (
          <li key={e.seq} data-type={e.type} data-closed={e.closed ? '' : undefined}>
            <time dateTime={e.at}>{e.when}</time> ·{' '}
            <span className="timeline-actor">{e.actor}</span>
            <strong>{e.text}</strong>
            {e.detail ? <span className="timeline-detail">{e.detail}</span> : null}
          </li>
        ))}
      </ol>
    </article>
  );
}
