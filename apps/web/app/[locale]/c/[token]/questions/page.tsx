import { notFound } from 'next/navigation';
import { Text } from '@/components/Text';
import { asLocale, t } from '@/lib/i18n';
import { loadQuestionScreen } from '@/lib/questions';

// One question at a time (D-10): the question the rules engine wants answered next, why,
// and what the answer settles; each option is one form. After the last, what the answers
// settled and the list to revisit them from.

export const dynamic = 'force-dynamic';

export default async function QuestionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; token: string }>;
  searchParams: Promise<{ revisit?: string; settled?: string; checking?: string }>;
}) {
  const { locale: localeParam, token } = await params;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const query = await searchParams;
  const screen = await loadQuestionScreen(token, locale, {
    ...(query.revisit ? { revisit: query.revisit } : {}),
    ...(query.settled ? { settled: query.settled } : {}),
    ...(query.checking ? { checking: query.checking } : {}),
  });
  if (!screen) notFound();
  const base = `/${locale}/c/${token}`;
  const q = screen.question;
  const dots = Array.from({ length: Math.max(screen.total, 1) }, (_, i) => (
    <i key={i} className={i < screen.index ? 'on' : ''} />
  ));
  return (
    <article
      className="screen narrow questions"
      data-answered={screen.answered.length}
      data-total={screen.total}
    >
      <p>
        <a href={base} className="lnk">
          ‹ <Text of={t(locale, 'artefact.back')} /> {screen.caseId}
        </a>
      </p>
      {screen.settledNow.length > 0 ? (
        <p role="status" className="q-settled" data-settled={screen.settledNow.join('|')}>
          <Text of={t(locale, 'questions.settledNow')} /> {screen.settledNow.join('; ')}
        </p>
      ) : null}
      {screen.checkJobId ? (
        <p role="status" className="q-settled" data-check-job={screen.checkJobId}>
          <Text of={t(locale, 'questions.checkQueued')} />
        </p>
      ) : null}
      {q ? (
        <div className="q-wrap" data-question={q.id} data-current={q.current ?? ''}>
          <div className="q-prog">{dots}</div>
          <p className="eyebrow">
            <Text of={t(locale, 'questions.question')} /> {screen.index}{' '}
            <Text of={t(locale, 'questions.of')} /> {screen.total}
          </p>
          <h2 className="q-text">{q.asks}</h2>
          <p className="q-why">{q.why}</p>
          {q.settles.length > 0 ? (
            <p className="q-unlock" data-settles={q.settles.length}>
              <Text of={t(locale, 'questions.settles')} /> {q.settles.join('; ')}
            </p>
          ) : null}
          <div className="q-opts">
            {q.options.map((o) => (
              <form
                key={o.id}
                method="post"
                action={`${base}/questions/${q.id}/answer`}
                className="inline"
              >
                <input type="hidden" name="option" value={o.id} />
                <button
                  type="submit"
                  className={o.check ? 'q-opt check' : 'q-opt'}
                  data-option={o.id}
                  aria-pressed={q.current === o.id}
                >
                  {o.label}
                  {o.check ? (
                    <span className="k">
                      <Text of={t(locale, 'questions.weLook')} />
                    </span>
                  ) : null}
                </button>
              </form>
            ))}
          </div>
        </div>
      ) : (
        <div className="q-wrap q-done" data-done="">
          <p className="big">
            <Text of={t(locale, 'questions.done')} />
          </p>
          <p className="muted" data-duties-settled={screen.dutiesSettled}>
            {screen.dutiesSettled} <Text of={t(locale, 'questions.dutiesSettled')} />
          </p>
        </div>
      )}
      {!q && screen.answered.length > 0 ? (
        <section className="answered">
          <Text of={t(locale, 'questions.answered')} as="h3" />
          <ul>
            {screen.answered.map((a) => (
              <li key={a.id} data-answered-question={a.id} data-answer={a.label}>
                {a.asks} <strong>{a.label}</strong> ·{' '}
                <a href={`${base}/questions?revisit=${a.id}`} data-revisit={a.id}>
                  <Text of={t(locale, 'questions.change')} />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
