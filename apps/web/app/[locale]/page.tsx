import { notFound } from 'next/navigation';
import { Text } from '@/components/Text';
import { asLocale, t } from '@/lib/i18n';

// The shell's home. The front door itself (the domain field and the scan) is U-02; this
// page proves the plumbing: server-rendered, localised, themed.

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const locale = asLocale((await params).locale);
  if (!locale) notFound();
  return (
    <article className="home">
      <Text of={t(locale, 'home.heading')} as="h1" />
      <Text of={t(locale, 'home.lead')} as="p" />
      <p className="home-soon">
        <Text of={t(locale, 'home.soon')} />
      </p>
    </article>
  );
}
