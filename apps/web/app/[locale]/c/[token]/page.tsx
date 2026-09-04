import { notFound } from 'next/navigation';
import { Progress } from '@/components/Progress';
import { Text } from '@/components/Text';
import {
  loadCasePage,
  type CaseFindingView,
  type CaseEvidenceView,
  type ColleagueOutcome,
} from '@/lib/case';
import { asLocale, t } from '@/lib/i18n';
import type { Locale } from '@gc/contracts';

// The case page for whoever holds the token (U-03, C-04, P-02): the case number and
// the domain, what is left to fix and how far along it is, the findings in the order to
// take them with the evidence behind each and the fix next to it, the colleagues and
// where they are, and the two actions that prove the case is theirs. No score anywhere.

export const dynamic = 'force-dynamic';

const ROLES = ['marketing', 'it', 'hr', 'finance'] as const;
const BODY_LIMIT = 6000;

function evidenceBody(e: CaseEvidenceView): string {
  if (e.kind === 'pass_diff' || e.kind === 'registry_record') {
    try {
      return JSON.stringify(JSON.parse(e.body), null, 2);
    } catch {
      return e.body;
    }
  }
  return e.body;
}

function Evidence({ e, locale }: { e: CaseEvidenceView; locale: Locale }) {
  const body = evidenceBody(e);
  const cut = BODY_LIMIT < body.length;
  return (
    <div className="ev" data-evidence={e.id} data-kind={e.kind}>
      <p className="ev-cap">
        <span className="mono">{e.kind}</span>
        {e.caption ? <> · {e.caption}</> : null}
        {e.observedAt ? <> · {e.observedAt}</> : null} ·{' '}
        <time dateTime={e.capturedAt}>{e.capturedAt.slice(0, 16).replace('T', ' ')}</time> ·{' '}
        <span className="mono">{e.hash.slice(0, 12)}</span>
      </p>
      {e.quote ? (
        <p className="ev-quote">
          <Text of={t(locale, 'case.evidence.quote')} />: <q>{e.quote}</q>
        </p>
      ) : null}
      {e.kind === 'screenshot' ? (
        <img alt={e.caption ?? e.id} src={`data:image/png;base64,${e.body}`} />
      ) : (
        <pre className="pre">{cut ? `${body.slice(0, BODY_LIMIT)}\n…` : body}</pre>
      )}
    </div>
  );
}

function Action({ f }: { f: CaseFindingView }) {
  const a = f.remedy.action;
  if (!a) return null;
  if (a.kind === 'link')
    return (
      <p className="rem-act">
        <a href={a.url} rel="noreferrer">
          {a.label}
        </a>
      </p>
    );
  if (a.kind === 'message') {
    const href = `mailto:${encodeURIComponent(a.to)}?subject=${encodeURIComponent(a.subject)}&body=${encodeURIComponent(a.body)}`;
    return (
      <details className="drawer rem-act">
        <summary>{a.label}</summary>
        <div className="body">
          <p className="mono">
            {a.to} · {a.subject}
          </p>
          <pre className="pre">{a.body}</pre>
          <a className="btn btn-2" href={href}>
            {a.label}
          </a>
        </div>
      </details>
    );
  }
  return (
    <details className="drawer rem-act">
      <summary>{a.label}</summary>
      <div className="body">
        <pre className="pre">{a.body}</pre>
      </div>
    </details>
  );
}

function Verify({
  f,
  base,
  locale,
  primary,
}: {
  f: CaseFindingView;
  base: string;
  locale: Locale;
  primary: boolean;
}) {
  if (!f.open) return null;
  const label = f.remedy.verifyLabel;
  const cls = primary ? 'btn' : 'btn btn-2';
  switch (f.remedy.verify) {
    case 'rescan':
      return (
        <form method="post" action={`${base}/check/${f.id}`} className="step-act">
          <button type="submit" className={cls}>
            {label ?? t(locale, 'case.remedy.check').text}
          </button>
        </form>
      );
    case 'attestation':
      return (
        <form method="post" action={`${base}/attest/${f.id}`} className="step-act">
          <button type="submit" className={cls}>
            {label ?? t(locale, 'case.remedy.attest').text}
          </button>
        </form>
      );
    case 'artefact_published':
      return (
        <p className="step-meta">
          <Text of={t(locale, 'case.remedy.artefact')} />
        </p>
      );
    case 'answer':
      return (
        <p className="step-meta">
          <Text of={t(locale, 'case.remedy.answer')} />
        </p>
      );
    default:
      return (
        <p className="step-meta">
          <Text of={t(locale, 'case.remedy.none')} />
        </p>
      );
  }
}

export default async function CasePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; token: string }>;
  searchParams: Promise<{ outcome?: string; checked?: string; attested?: string }>;
}) {
  const { locale: localeParam, token } = await params;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const view = await loadCasePage(token, locale);
  if (!view) notFound();
  const { counts, members, progress, findings } = view;
  const base = `/${locale}/c/${token}`;
  const who = view.claimed ? t(locale, 'case.who.claimed') : t(locale, 'case.who.unclaimed');
  const query = await searchParams;
  const outcome = query.outcome as ColleagueOutcome | undefined;
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
  const severityText = {
    blocking: t(locale, 'severity.blocking'),
    serious: t(locale, 'severity.serious'),
    advisory: t(locale, 'severity.advisory'),
    closed: t(locale, 'severity.closed'),
  };
  const sevKey = (f: CaseFindingView) =>
    !f.open
      ? 'closed'
      : f.severity === 'blocking' || f.severity === 'advisory'
        ? f.severity
        : 'serious';

  const readyOne = t(locale, 'case.ready.one');
  const readyMany = t(locale, 'case.ready');
  const open = findings.filter((f) => f.open);
  const done = findings.length - open.length;
  const minutes = open.reduce((sum, f) => sum + f.remedy.minutes, 0);
  const percent = findings.length === 0 ? 100 : Math.round((done / findings.length) * 100);
  const nowId = open[0]?.id;
  const stepClass = (f: CaseFindingView) => (!f.open ? 'done' : f.id === nowId ? 'now' : 'next');
  const notice =
    query.checked === '1'
      ? t(locale, 'case.checked')
      : query.attested === '1'
        ? t(locale, 'case.attested')
        : undefined;

  return (
    <article className="case screen narrow">
      <header className="plan-top">
        <span className="caseid">{view.caseId}</span>
        <span className="plan-dom">{view.domain}</span>
        <span className="plan-saved">
          <Text of={who} />
        </span>
      </header>
      <h1 className="plan-lead">
        {open.length === 0 ? (
          <Text of={t(locale, 'case.ready.none')} />
        ) : (
          <>
            {open.length} <Text of={open.length === 1 ? readyOne : readyMany} />
          </>
        )}
      </h1>
      <div className="plan-prog" data-done={done} data-total={findings.length}>
        <div
          className="pp-bar"
          role="progressbar"
          aria-valuenow={done}
          aria-valuemax={findings.length}
        >
          <i style={{ width: `${percent}%` }} />
        </div>
        <span className="pp-txt">
          {done} <Text of={t(locale, 'case.progress.of')} /> {findings.length}{' '}
          <Text of={t(locale, 'case.progress.done')} />
          {minutes > 0 ? (
            <>
              {' '}
              · <Text of={t(locale, 'case.progress.about')} /> {minutes}{' '}
              <Text of={t(locale, 'case.progress.left')} />
            </>
          ) : null}
        </span>
      </div>
      {notice ? (
        <p role="status" className="muted">
          <Text of={notice} />
        </p>
      ) : null}

      <ol className="steps">
        {findings.map((f, i) => (
          <li
            key={f.id}
            className={`step ${stepClass(f)}`}
            data-finding={f.id}
            data-type={f.typeId}
            data-severity={f.severity}
            data-status={f.open ? 'open' : 'closed'}
          >
            <span className="step-n">{i + 1}</span>
            <div className="step-body">
              {stepClass(f) === 'now' ? (
                <div className="step-kick">
                  <Text of={t(locale, 'case.step.now')} />
                </div>
              ) : null}
              <div className="fd-head">
                <span className="fid">{f.typeId}</span>
                <span className={`sev sev-${sevKey(f)}`}>
                  <Text of={severityText[sevKey(f)]} />
                </span>
                <span className="step-meta">
                  {f.area}
                  {f.remedy.effort ? <> · {f.remedy.effort}</> : null}
                </span>
              </div>
              <h3>{f.remedy.title}</h3>
              {f.citations.length > 0 ? (
                <p className="cites">
                  <Text of={t(locale, 'case.rule')} />
                  {f.citations.map((c) => (
                    <span className="cite" key={c}>
                      {c}
                    </span>
                  ))}
                  {f.authority ? <em className="muted">{f.authority}</em> : null}
                </p>
              ) : null}
              <details className="drawer evidence" open data-evidence-for={f.id}>
                <summary>
                  <Text of={t(locale, 'case.evidence')} /> ({f.evidence.length})
                </summary>
                <div className="body">
                  {f.evidence.length === 0 ? (
                    <Text of={t(locale, 'case.evidence.none')} as="p" />
                  ) : (
                    f.evidence.map((e) => <Evidence key={e.id} e={e} locale={locale} />)
                  )}
                </div>
              </details>
              <div className={`rem-card k-${f.remedy.kind}`}>
                {f.remedy.detail ? <p>{f.remedy.detail}</p> : null}
                {f.remedy.snippet ? (
                  <details className="drawer">
                    <summary>
                      <Text of={t(locale, 'case.remedy.snippet')} />
                    </summary>
                    <div className="body">
                      <pre className="pre">{f.remedy.snippet}</pre>
                    </div>
                  </details>
                ) : null}
                <Action f={f} />
                <Verify f={f} base={base} locale={locale} primary={f.id === nowId} />
              </div>
            </div>
          </li>
        ))}
        {open.length === 0 ? (
          <li className="step now" data-watch="">
            <span className="step-n">{findings.length + 1}</span>
            <div className="step-body">
              <h3>
                <Text of={t(locale, 'case.watch')} />
              </h3>
            </div>
          </li>
        ) : null}
      </ol>

      <nav className="no-print">
        <a href={`${base}/timeline`}>
          <Text of={t(locale, 'case.timeline')} />
        </a>
      </nav>

      <section className="no-print">
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

      <Progress progress={progress} locale={locale} />

      <section className="colleagues no-print">
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

      <section className="no-print">
        <p>
          <a href={`${base}/export.json`} download={`${view.caseId}.json`}>
            <Text of={t(locale, 'case.export')} />
          </a>
        </p>
        <Text of={t(locale, 'case.export.note')} as="p" />
        <p>
          <a href={`${base}/evidence-pack.zip`} download={`${view.caseId}-evidence-pack.zip`}>
            <Text of={t(locale, 'case.pack')} />
          </a>
        </p>
        <Text of={t(locale, 'case.pack.note')} as="p" />
      </section>

      <section className="no-print">
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
