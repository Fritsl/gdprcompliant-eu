import { notFound } from 'next/navigation';
import { Dive } from '@/components/Dive';
import { Text } from '@/components/Text';
import { Verbatim } from '@/components/Verbatim';
import { QUESTION_MAX, QUESTION_MIN, loadAdvisor } from '@/lib/advisor';
import { asLocale, t } from '@/lib/i18n';

// The advisor (V-02): one question at a time, answered in three parts kept apart, the
// answer, what the case says (each fact linking to the evidence or the answer that
// placed it) and what the law says (each passage quoted, with its reference). A
// question the case holds nothing on gets a refusal and the catalogue question that
// would settle it, with a way to answer that question now.

export const dynamic = 'force-dynamic';

export default async function AdvisorPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; token: string }>;
  searchParams: Promise<{ outcome?: string; thread?: string }>;
}) {
  const { locale: localeParam, token } = await params;
  const { outcome, thread } = await searchParams;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const view = await loadAdvisor(token, thread);
  if (!view) notFound();
  const base = `/${locale}/c/${token}`;
  const notices = {
    unavailable: t(locale, 'advisor.unavailable'),
    invalid: t(locale, 'advisor.invalid'),
    answered: t(locale, 'advisor.answered'),
    refused: t(locale, 'advisor.answered'),
  } as const;
  const notice =
    outcome && outcome in notices ? notices[outcome as keyof typeof notices] : undefined;
  // A conversation reads oldest first; the list of everything, newest first.
  const shown = view.thread ? [...view.advice] : [...view.advice].reverse();
  return (
    <article
      className="screen advisor"
      data-advice={view.advice.length}
      {...(view.thread ? { 'data-thread': view.thread } : {})}
    >
      <p className="eyebrow">
        <a href={base} data-back="">
          <Text of={t(locale, 'advisor.back')} />
        </a>
      </p>
      <h1>
        <Text of={t(locale, 'advisor.heading')} />
      </h1>
      <Text of={t(locale, 'advisor.lead')} as="p" />
      {view.thread ? (
        <p className="eyebrow" data-thread-nav="">
          <Text of={t(locale, 'advisor.thread')} />
          {' · '}
          <a href={`${base}/advisor`} data-all-threads="">
            <Text of={t(locale, 'advisor.allThreads')} />
          </a>
        </p>
      ) : null}
      <p className="notice" data-advisor-notice="">
        <Text of={t(locale, 'advisor.notice')} />
      </p>
      {notice ? (
        <p className="notice" data-outcome={outcome} role="status">
          <Text of={notice} />
        </p>
      ) : null}
      {view.available ? (
        <form
          method="post"
          action={`${base}/advisor/ask`}
          className="advisor-ask"
          data-advisor-form=""
        >
          {view.thread ? <input type="hidden" name="thread" value={view.thread} /> : null}
          <label htmlFor="advisor-question">
            {view.thread ? (
              <Text of={t(locale, 'advisor.followUp')} />
            ) : (
              <Text of={t(locale, 'advisor.question')} />
            )}
          </label>
          <textarea
            id="advisor-question"
            name="question"
            required
            minLength={QUESTION_MIN}
            maxLength={QUESTION_MAX}
            rows={3}
            placeholder={t(locale, 'advisor.placeholder').text}
          />
          <button type="submit" className="primary" data-advisor-ask="">
            <Text of={t(locale, 'advisor.ask')} />
          </button>
        </form>
      ) : (
        <p className="muted" data-advisor-unavailable="">
          <Text of={t(locale, 'advisor.unavailable')} />
        </p>
      )}
      {shown.length === 0 ? (
        <p className="muted" data-advisor-empty="">
          <Text of={t(locale, 'advisor.none')} />
        </p>
      ) : (
        <ol className="advice-list" data-advice-list="">
          {shown.map((a) => (
            <li
              key={a.at + a.question}
              className="advice"
              data-advice-item=""
              data-refused={a.refused ? 'true' : 'false'}
              {...(a.thread ? { 'data-thread-id': a.thread.id, 'data-turn': a.thread.turn } : {})}
              {...(a.dive
                ? { 'data-dive-origin': `${a.dive.origin.kind}:${a.dive.origin.ref}` }
                : {})}
            >
              <h2>{a.question}</h2>
              {a.dive ? (
                <p className="muted" data-dived-from="">
                  <Text of={t(locale, 'advisor.divedFrom')} /> {a.dive.origin.kind}{' '}
                  {a.dive.origin.ref}
                </p>
              ) : null}
              {a.thread && !view.thread ? (
                <p className="muted">
                  <a
                    href={`${base}/advisor?thread=${encodeURIComponent(a.thread.id)}`}
                    data-open-thread=""
                  >
                    <Text of={t(locale, 'advisor.thread')} />
                  </a>
                </p>
              ) : null}
              {a.refused ? (
                <section data-advice-refused="">
                  <h3>
                    <Text of={t(locale, 'advisor.refused')} />
                  </h3>
                  <p>{a.refused.reason}</p>
                  {a.refused.question ? (
                    <p data-advice-settle={a.refused.question.id}>
                      <Text of={t(locale, 'advisor.settle')} />
                      {': '}
                      {a.refused.question.asks}{' '}
                      <a
                        href={`${base}/questions#${a.refused.question.id}`}
                        data-advice-answer-it=""
                      >
                        <Text of={t(locale, 'advisor.answerIt')} />
                      </a>
                    </p>
                  ) : null}
                </section>
              ) : (
                <section data-advice-answer="">
                  <h3>
                    <Text of={t(locale, 'advisor.answer')} />
                  </h3>
                  <p>{a.answer}</p>
                  <Dive
                    base={base}
                    locale={locale}
                    kind="answer"
                    refId={a.at}
                    fragment={a.answer}
                    {...(a.thread ? { thread: a.thread.id } : {})}
                  />
                </section>
              )}
              {a.caseSays.length > 0 ? (
                <section data-advice-case="">
                  <h3>
                    <Text of={t(locale, 'advisor.caseSays')} />
                  </h3>
                  <ul>
                    {a.caseSays.map((f, i) => (
                      <li key={i} data-fact-kind={f.kind}>
                        <strong>{f.label}</strong> {f.value}{' '}
                        {f.pointer.kind === 'evidence' ? (
                          <a
                            href={`${base}#evidence-${f.pointer.evidenceId}`}
                            data-fact-evidence={f.pointer.evidenceId}
                          >
                            <Text of={t(locale, 'advisor.evidence')} />
                          </a>
                        ) : (
                          <a
                            href={`${base}/questions#${f.pointer.questionId}`}
                            data-fact-answer={f.pointer.answerId}
                          >
                            <Text of={t(locale, 'questions.answered')} />
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {a.lawSays.length > 0 ? (
                <section data-advice-law="">
                  <h3>
                    <Text of={t(locale, 'advisor.lawSays')} />
                  </h3>
                  <ul>
                    {a.lawSays.map((l) => (
                      <li key={l.key} data-law-key={l.key}>
                        <Verbatim
                          cite={l.citation}
                          jurisdiction={a.jurisdiction}
                          corpusVersion={l.corpusVersion}
                          mark={l.quote}
                          locale={locale}
                        />
                        <Dive
                          base={base}
                          locale={locale}
                          kind="article"
                          refId={l.key}
                          fragment={l.quote}
                          {...(a.thread ? { thread: a.thread.id } : {})}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <p className="muted">
        <Text of={t(locale, 'advisor.inReport')} />
      </p>
    </article>
  );
}
