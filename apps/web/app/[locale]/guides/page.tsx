import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ScanForm } from '@/components/ScanForm';
import { Text } from '@/components/Text';
import { allLocales, guideUrl, languagesOf, listGuides } from '@/lib/guides';
import { asLocale, t } from '@/lib/i18n';

// Every guide (S-15, U-06): one page per thing a scan can find, grouped by area. A guide
// not written in the reader's language is listed in the language it exists in, and the
// link says so. Generated at build time, with its canonical address and hreflang set.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const locale = asLocale((await params).locale);
  if (!locale) return {};
  const url = guideUrl(locale);
  return {
    title: `${t(locale, 'guides.heading').text} · ${t(locale, 'shell.name').text}`,
    description: t(locale, 'guides.lead').text,
    alternates: { canonical: url, languages: languagesOf(allLocales()) },
    openGraph: {
      type: 'website',
      url,
      locale,
      siteName: t(locale, 'shell.name').text,
      title: t(locale, 'guides.heading').text,
      description: t(locale, 'guides.lead').text,
    },
  };
}

function areaOf(g: { area: string }): string {
  return g.area;
}

export default async function GuidesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: localeParam } = await params;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const guides = listGuides(locale);
  const areas = [...new Set(guides.map(areaOf))];
  return (
    <article className="screen narrow guides">
      <Text of={t(locale, 'guides.heading')} as="h1" />
      <Text of={t(locale, 'guides.lead')} as="p" />
      {areas.map((area) => (
        <section key={area} data-area={area}>
          <h2>{area}</h2>
          <ul className="guide-list">
            {guides
              .filter((g) => g.area === area)
              .map((g) => (
                <li key={g.id} data-guide={g.id}>
                  <span className="fid">{g.findingTypeId}</span>{' '}
                  <a
                    href={g.href}
                    hrefLang={g.locale}
                    {...(g.locale !== locale ? { lang: g.locale } : {})}
                  >
                    {g.title}
                  </a>
                </li>
              ))}
          </ul>
        </section>
      ))}
      <section className="fd" data-scan="">
        <Text of={t(locale, 'guide.check')} as="h2" />
        <ScanForm locale={locale} />
      </section>
    </article>
  );
}
