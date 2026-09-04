import { notFound } from 'next/navigation';
import { Text } from '@/components/Text';
import { guideView } from '@/lib/guides';
import { asLocale, t } from '@/lib/i18n';

// One guide (S-15, R-03): what is wrong, why it matters, what to change, how to see it
// worked, the rule it rests on per jurisdiction, and the change as code where there is
// one. A standalone page, so it stands up as a landing page from a search.

export const dynamic = 'force-dynamic';

export default async function GuidePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: localeParam, id } = await params;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const guide = guideView(id, locale);
  if (!guide) notFound();
  return (
    <article className="screen narrow guide" data-guide={guide.id} data-type={guide.findingTypeId}>
      <p className="eyebrow">
        <Text of={t(locale, 'guide.finding')} /> {guide.findingTypeId} · {guide.area}
      </p>
      <h1 className="plan-lead">{guide.title}</h1>
      <section>
        <Text of={t(locale, 'guide.wrong')} as="h2" />
        <p>{guide.wrong}</p>
      </section>
      <section>
        <Text of={t(locale, 'guide.why')} as="h2" />
        <p>{guide.why}</p>
      </section>
      <section>
        <Text of={t(locale, 'guide.steps')} as="h2" />
        <ol className="guide-steps">
          {guide.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        {guide.snippet ? (
          <details className="drawer code-alt">
            <summary>
              <Text of={t(locale, 'guide.snippet')} />
              {guide.remedyTitle ? <> · {guide.remedyTitle}</> : null}
            </summary>
            <div className="body">
              <pre className="pre">{guide.snippet}</pre>
            </div>
          </details>
        ) : null}
      </section>
      <section>
        <Text of={t(locale, 'guide.confirm')} as="h2" />
        <p>{guide.confirm}</p>
      </section>
      <section data-law="">
        <Text of={t(locale, 'guide.law')} as="h2" />
        <ul className="guide-law">
          {guide.law.map((l) => (
            <li key={l.jurisdiction} data-jurisdiction={l.jurisdiction}>
              <strong>{l.jurisdiction}</strong> · {l.authority}
              <ul>
                {l.citations.map((c) => (
                  <li key={c} className="mono">
                    {c}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
      <p className="step-act">
        <a className="btn" href={`/${locale}`} data-cta="">
          <Text of={t(locale, 'guide.check')} />
        </a>{' '}
        <a className="lnk" href={`/${locale}/guides`}>
          <Text of={t(locale, 'guide.all')} />
        </a>
      </p>
    </article>
  );
}
