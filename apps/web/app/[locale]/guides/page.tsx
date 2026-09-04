import { notFound } from 'next/navigation';
import { Text } from '@/components/Text';
import { listGuides } from '@/lib/guides';
import { asLocale, t } from '@/lib/i18n';

// Every guide (S-15): one page per thing a scan can find, grouped by area.

export const dynamic = 'force-dynamic';

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
                  <a href={`/${locale}/guides/${g.id}`}>{g.title}</a>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </article>
  );
}
