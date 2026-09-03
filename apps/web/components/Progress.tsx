import type { CaseProgress } from '@gc/db';
import { Text } from '@/components/Text';
import { t } from '@/lib/i18n';
import type { Locale } from '@gc/contracts';

// Where the case stands (P-03): the same numbers for everyone on it. Counts per desk,
// never the findings behind them.

export function Progress({ progress, locale }: { progress: CaseProgress; locale: Locale }) {
  const roleLabel = {
    marketing: t(locale, 'progress.role.marketing'),
    it: t(locale, 'progress.role.it'),
    hr: t(locale, 'progress.role.hr'),
    finance: t(locale, 'progress.role.finance'),
  };
  return (
    <section className="progress" data-percent={progress.percent}>
      <Text of={t(locale, 'progress.heading')} as="h2" />
      <p>
        <Text of={t(locale, 'progress.stage')} /> {progress.stage} · {progress.done}/
        {progress.done + progress.open} · {progress.percent}%
      </p>
      <ul>
        {progress.roles.map((r) => (
          <li key={r.role} data-role={r.role}>
            <Text of={roleLabel[r.role]} />: {r.done} <Text of={t(locale, 'progress.done')} />,{' '}
            {r.open} <Text of={t(locale, 'progress.open')} />
          </li>
        ))}
      </ul>
    </section>
  );
}
