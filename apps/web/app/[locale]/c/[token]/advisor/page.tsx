import { notFound } from 'next/navigation';
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
  searchParams: Promise<{ outcome?: string }>;
}) {
  const { locale: localeParam, token } = await params;
  const { outcome } = await searchParams;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const view = await loadAdvisor(token);
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
  const latestFirst = [...view.advice].reverse();
  return (
    <article className="screen advisor" data-advice={view.advice.length}>
      <p className="eyebrow">
        <a href={base} data-back="">
          <Text of={t(locale, 'advisor.back')} />
        </a>
      </p>
      <h1>
        <Text of={t(locale, 'advisor.heading')} />
      </h1>
      <Text of={t(locale, 'advisor.lead')} as="p" />
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
          <label htmlFor="advisor-question">
            <Text of={t(locale, 'advisor.question')} />
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
      {latestFirst.length === 0 ? (
        <p className="muted" data-advisor-empty="">
          <Text of={t(locale, 'advisor.none')} />
        </p>
      ) : (
        <ol className="advice-list" data-advice-list="">
          {latestFirst.map((a) => (
            <li
              key={a.at + a.question}
              className="advice"
              data-advice-item=""
              data-refused={a.refused ? 'true' : 'false'}
            >
              <h2>{a.question}</h2>
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
