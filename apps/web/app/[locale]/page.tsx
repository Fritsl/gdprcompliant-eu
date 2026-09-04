import { notFound } from 'next/navigation';
import { ScanForm } from '@/components/ScanForm';
import { Text } from '@/components/Text';
import { asLocale, t } from '@/lib/i18n';

// The front door (U-02): one field, one button, no account. A refused start comes back
// here with its reason, said once, above the field.

export const dynamic = 'force-dynamic';

export default async function Home({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ outcome?: string; retry?: string; ref?: string }>;
}) {
  const locale = asLocale((await params).locale);
  if (!locale) notFound();
  const { outcome, ref } = await searchParams;
  // The referral code (L-04) from our own link, kept only if it looks like one.
  const referral = ref && /^[a-f0-9]{12}$/.test(ref) ? ref : undefined;
  const refusal =
    outcome === 'invalid'
      ? t(locale, 'front.invalid')
      : outcome === 'limited'
        ? t(locale, 'front.limited')
        : outcome === 'busy'
          ? t(locale, 'front.busy')
          : undefined;
  return (
    <article className="fd">
      <div>
        <p className="eyebrow">
          <Text of={t(locale, 'front.eyebrow')} />
        </p>
        <Text of={t(locale, 'front.heading')} as="h1" />
        <p className="sub">
          <Text of={t(locale, 'front.sub')} />
        </p>
      </div>
      {refusal ? (
        <p className="notice" role="alert" data-outcome={outcome}>
          <Text of={refusal} />
        </p>
      ) : null}
      <ScanForm locale={locale} {...(referral ? { referral } : {})} />
    </article>
  );
}
