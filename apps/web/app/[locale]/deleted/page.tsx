import { notFound } from 'next/navigation';
import { Text } from '@/components/Text';
import { asLocale, t } from '@/lib/i18n';

// After a hard delete (C-04): the one record that remains, shown once.

export const dynamic = 'force-dynamic';

export default async function Deleted({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ audit?: string; rows?: string }>;
}) {
  const locale = asLocale((await params).locale);
  if (!locale) notFound();
  const { audit, rows } = await searchParams;
  const id = /^[a-f0-9]{64}$/.test(audit ?? '') ? audit : undefined;
  return (
    <article className="deleted">
      <Text of={t(locale, 'deleted.heading')} as="h1" />
      <Text of={t(locale, 'deleted.lead')} as="p" />
      {id ? (
        <p>
          <code>{id}</code>
          {/^\d+$/.test(rows ?? '') ? (
            <>
              {' · '}
              {rows} <Text of={t(locale, 'deleted.rows')} />
            </>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}
