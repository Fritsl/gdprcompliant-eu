import { notFound } from 'next/navigation';
import { Progress } from '@/components/Progress';
import { Text } from '@/components/Text';
import { loadMemberList } from '@/lib/case';
import { asLocale, t } from '@/lib/i18n';

// A colleague's list (P-01, P-02): reached by their invitation link, no account, no
// form. Opening it is the acceptance; the list is the next thing they see.

export const dynamic = 'force-dynamic';

export default async function MemberPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; invite: string }>;
  searchParams: Promise<{ checked?: string }>;
}) {
  const { locale: localeParam, invite } = await params;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const view = await loadMemberList(invite, locale);
  if (!view) notFound();
  const { checked } = await searchParams;
  const base = `/${locale}/m/${invite}`;
  return (
    <article className="member">
      <h1>
        <Text of={t(locale, 'member.heading')} /> · {view.caseId}
      </h1>
      <p>
        <Text of={t(locale, 'member.from')} /> {view.member.invitedBy}
      </p>
      <Progress progress={view.progress} locale={locale} />
      {checked ? (
        <p role="status">
          <Text of={t(locale, 'member.checked')} />
        </p>
      ) : null}
      {view.lists.map((list) => (
        <section key={list.role} data-role={list.role}>
          <h2>{list.label}</h2>
          {list.items.length === 0 ? (
            <Text of={t(locale, 'member.none')} as="p" />
          ) : (
            <ol className="role-list">
              {list.items.map((item) => (
                <li key={item.findingId} data-finding={item.findingId} data-kind={item.kind}>
                  <span className="kind">{item.kindLabel}</span> <strong>{item.text}</strong>{' '}
                  <form method="post" action={`${base}/check/${item.findingId}`} className="inline">
                    <button type="submit">{item.checkForMe.label}</button>
                  </form>
                </li>
              ))}
            </ol>
          )}
          {list.deferred > 0 ? (
            <p>
              {list.deferred} <Text of={t(locale, 'member.deferred')} />
            </p>
          ) : null}
        </section>
      ))}
    </article>
  );
}
