import { notFound } from 'next/navigation';
import { Text } from '@/components/Text';
import { asLocale, t } from '@/lib/i18n';
import { scannerBehaviourView } from '@/lib/scanner';

// How the scanner behaves (D-11): the page the user agent points at. Rendered from the
// content the scanner reads its identity and limits from, so what is published is
// what runs; a test holds the code to it.

export const dynamic = 'force-dynamic';

export default async function ScannerPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: localeParam } = await params;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const v = scannerBehaviourView(locale);
  return (
    <article className="screen narrow scanner" data-behaviour-version={v.version}>
      <h1>{v.title}</h1>
      <p>{v.lead}</p>
      <p className="mono" data-user-agent={v.userAgent}>
        {v.userAgent}
      </p>
      <p className="mono" data-identity-header={v.header}>
        {v.header}: {v.contact}
      </p>
      {v.sections.map((s) => (
        <section key={s.id} data-section={s.id}>
          <h2>{s.heading}</h2>
          <p>{s.body}</p>
        </section>
      ))}
      <p className="muted">
        <Text of={t(locale, 'scanner.version')} /> {v.version}
      </p>
    </article>
  );
}
