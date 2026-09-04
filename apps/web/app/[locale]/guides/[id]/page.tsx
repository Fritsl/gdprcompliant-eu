import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ScanForm } from '@/components/ScanForm';
import { Text } from '@/components/Text';
import { guidePages, guideUrl, guideView, languagesOf } from '@/lib/guides';
import { asLocale, t } from '@/lib/i18n';

// One guide (S-15, R-03, U-06): what is wrong, why it matters, what to change, how to
// see it worked, the rule it rests on per jurisdiction, the change as code where there
// is one, and the scan form at the end. Generated at build time for every locale the
// guide is written in, with its canonical address and its hreflang set, so it stands up
// as a landing page from a search.

export const dynamicParams = false;

// Every page that exists, from the bottom up: the locale and the id together, one
// entry per locale the guide is written in.
export function generateStaticParams() {
  return guidePages().flatMap((p) => p.locales.map((locale) => ({ locale, id: p.id })));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<Metadata> {
  const { locale: localeParam, id } = await params;
  const locale = asLocale(localeParam);
  if (!locale) return {};
  const guide = guideView(id, locale);
  if (!guide) return {};
  const url = guideUrl(locale, id);
  return {
    title: `${guide.title} · ${t(locale, 'shell.name').text}`,
    description: guide.wrong,
    keywords: [...guide.keywords],
    alternates: { canonical: url, languages: languagesOf(guide.locales, id) },
    openGraph: {
      type: 'article',
      url,
      locale,
      siteName: t(locale, 'shell.name').text,
      title: guide.title,
      description: guide.wrong,
    },
  };
}

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
    <article
      className="screen narrow guide"
      data-guide={guide.id}
      data-type={guide.findingTypeId}
      data-locales={guide.locales.join(' ')}
    >
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
        <p>
          <a className="lnk" href={`/${locale}/guides`}>
            <Text of={t(locale, 'guide.all')} />
          </a>
        </p>
      </section>
      <section className="fd" data-scan="">
        <Text of={t(locale, 'guide.check')} as="h2" />
        <ScanForm locale={locale} />
      </section>
    </article>
  );
}
