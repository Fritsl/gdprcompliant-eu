import { t } from '@/lib/i18n';
import type { Locale } from '@gc/contracts';

// The scan entry point (U-02): one field, one button, no account. The front door and the
// end of every guide are the same form, so a reader who arrived from a search starts a
// scan without finding their way to the front page first.

export function ScanForm({ locale, referral }: { locale: Locale; referral?: string | undefined }) {
  return (
    <form method="post" action={`/${locale}/scan`} data-scan-form="">
      {referral ? <input type="hidden" name="ref" value={referral} /> : null}
      <input
        type="text"
        name="domain"
        inputMode="url"
        autoComplete="url"
        autoCapitalize="off"
        spellCheck={false}
        required
        aria-label={t(locale, 'front.field').text}
        placeholder={t(locale, 'front.placeholder').text}
      />
      <button className="btn" type="submit">
        {t(locale, 'front.cta').text}
      </button>
    </form>
  );
}
