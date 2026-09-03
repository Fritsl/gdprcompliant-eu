import { notFound } from 'next/navigation';
import { Text } from '@/components/Text';
import { loadCaseSummary, type ColleagueOutcome } from '@/lib/case';
import { asLocale, t } from '@/lib/i18n';

// The case page for whoever holds the token (C-04, P-02): what is held, who can see
// it, the colleagues and where they are, and the two actions that prove the case is
// theirs.

export const dynamic = 'force-dynamic';

const ROLES = ['marketing', 'it', 'hr', 'finance'] as const;

export default async function CasePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; token: string }>;
  searchParams: Promise<{ outcome?: string }>;
}) {
  const { locale: localeParam, token } = await params;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const view = await loadCaseSummary(token, locale);
  if (!view) notFound();
  const { counts, members } = view;
  const base = `/${locale}/c/${token}`;
  const who = view.claimed ? t(locale, 'case.who.claimed') : t(locale, 'case.who.unclaimed');
  const outcome = (await searchParams).outcome as ColleagueOutcome | undefined;
  const errorText = {
    rate_limited: t(locale, 'colleagues.error.tooMany'),
    reminded: t(locale, 'colleagues.error.reminded'),
    invalid: t(locale, 'colleagues.error.invalid'),
  };
  const error =
    outcome === 'rate_limited' || outcome === 'reminded' || outcome === 'invalid'
      ? errorText[outcome]
      : undefined;
  const statusText = {
    invited: t(locale, 'colleagues.status.invited'),
    joined: t(locale, 'colleagues.status.joined'),
    finished: t(locale, 'colleagues.status.finished'),
    revoked: t(locale, 'colleagues.status.revoked'),
    expired: t(locale, 'colleagues.status.expired'),
  };
  return (
    <article className="case">
      <h1>
        <Text of={t(locale, 'case.heading')} /> {view.caseId}
      </h1>
      <p>
        <a href={`${base}/timeline`}>
          <Text of={t(locale, 'case.timeline')} />
        </a>
      </p>

      <section>
        <Text of={t(locale, 'case.holds')} as="h2" />
        <ul>
          <li>
            {counts.findings} <Text of={t(locale, 'case.holds.findings')} />
          </li>
          <li>
            {counts.evidence} <Text of={t(locale, 'case.holds.evidence')} />
          </li>
          <li>
            {counts.answers} <Text of={t(locale, 'case.holds.answers')} />
          </li>
          <li>
            {counts.vendors} <Text of={t(locale, 'case.holds.vendors')} />
          </li>
          <li>
            {counts.events} <Text of={t(locale, 'case.holds.events')} />
          </li>
        </ul>
      </section>

      <section>
        <Text of={t(locale, 'case.who')} as="h2" />
        <Text of={who} as="p" />
      </section>

      <section className="colleagues">
        <Text of={t(locale, 'colleagues.heading')} as="h2" />
        {error ? (
          <p role="alert">
            <Text of={error} />
          </p>
        ) : null}
        {members.length === 0 ? (
          <Text of={t(locale, 'colleagues.none')} as="p" />
        ) : (
          <ul className="colleague-list">
            {members.map((m) => (
              <li key={m.memberId} data-status={m.status} data-role={m.role}>
                <strong>{m.email}</strong> · {m.role} · <Text of={statusText[m.status]} />
                {m.status !== 'revoked' && m.status !== 'expired' ? (
                  <>
                    {' '}
                    · {m.open} <Text of={t(locale, 'colleagues.open')} />
                  </>
                ) : null}
                {m.link ? (
                  <>
                    {' '}
                    · <Text of={t(locale, 'colleagues.link')} />:{' '}
                    <a href={m.link} data-invite-link="">
                      {m.link}
                    </a>
                  </>
                ) : null}
                {m.status === 'invited' || m.status === 'joined' ? (
                  <>
                    {' '}
                    <form method="post" action={`${base}/remind/${m.memberId}`} className="inline">
                      <button type="submit">
                        <Text of={t(locale, 'colleagues.remind')} />
                      </button>
                    </form>{' '}
                    <form method="post" action={`${base}/revoke/${m.memberId}`} className="inline">
                      <button type="submit">
                        <Text of={t(locale, 'colleagues.revoke')} />
                      </button>
                    </form>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <form method="post" action={`${base}/invite`} className="invite">
          <label>
            <Text of={t(locale, 'colleagues.invite.from')} />{' '}
            <input name="from" autoComplete="name" required maxLength={80} />
          </label>{' '}
          <label>
            <Text of={t(locale, 'colleagues.invite.email')} />{' '}
            <input name="email" type="email" autoComplete="off" required />
          </label>{' '}
          <label>
            <Text of={t(locale, 'colleagues.invite.role')} />{' '}
            <select name="role" defaultValue="it">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>{' '}
          <button type="submit">
            <Text of={t(locale, 'colleagues.invite')} />
          </button>
          <Text of={t(locale, 'colleagues.invite.expires')} as="p" />
        </form>
      </section>

      <section>
        <p>
          <a href={`${base}/export.json`} download={`${view.caseId}.json`}>
            <Text of={t(locale, 'case.export')} />
          </a>
        </p>
        <Text of={t(locale, 'case.export.note')} as="p" />
      </section>

      <section>
        <form method="post" action={`${base}/delete`}>
          <Text of={t(locale, 'case.delete.note')} as="p" />
          <label>
            <Text of={t(locale, 'case.delete.confirm')} />{' '}
            <input
              name="confirm"
              autoComplete="off"
              required
              pattern="[A-Z]{2}-[0-9]{2}-[A-Z0-9]{4}"
            />
          </label>{' '}
          <button type="submit">
            <Text of={t(locale, 'case.delete')} />
          </button>
        </form>
      </section>
    </article>
  );
}
