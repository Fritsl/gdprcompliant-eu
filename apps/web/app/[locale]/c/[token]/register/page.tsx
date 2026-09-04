import { notFound } from 'next/navigation';
import { REGISTER_CONTENT } from '@gc/artefacts';
import { localise } from '@gc/i18n';
import { Text } from '@/components/Text';
import { asLocale, t } from '@/lib/i18n';
import { loadRegister } from '@/lib/register';

// The processing register (G-01): the rows the scan read from the site, each a draft
// until the holder confirms it, in the visitor's language. Confirming a row is one
// form; the record downloads as the Article 30 document.

export const dynamic = 'force-dynamic';

export default async function RegisterPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; token: string }>;
  searchParams: Promise<{ confirmed?: string }>;
}) {
  const { locale: localeParam, token } = await params;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const view = await loadRegister(token, locale);
  if (!view) notFound();
  const { confirmed } = await searchParams;
  const base = `/${locale}/c/${token}`;
  const C = REGISTER_CONTENT;
  const lang = locale;
  function c(x: Parameters<typeof localise>[0]): string {
    return localise(x, lang).value;
  }
  function col(k: string): string {
    return c(C.columns[k]!);
  }
  return (
    <article
      className="screen narrow register"
      data-confirmed={view.confirmed}
      data-total={view.total}
    >
      <p>
        <a href={base} className="lnk">
          ‹ <Text of={t(locale, 'artefact.back')} /> {view.caseId}
        </a>
      </p>
      <Text of={t(locale, 'register.heading')} as="h1" />
      {confirmed === '1' ? (
        <p role="status">
          <Text of={t(locale, 'register.confirmedNow')} />
        </p>
      ) : null}
      <p>
        <a
          href={`${base}/register.md`}
          download={`${view.caseId}-register.md`}
          data-register-download=""
        >
          <Text of={t(locale, 'register.download')} />
        </a>
      </p>
      {view.rows.length === 0 ? <p>{c(C.empty)}</p> : null}
      <ol className="register-list">
        {view.rows.map((row) => (
          <li
            key={row.key}
            data-key={row.key}
            data-activity={row.activityId}
            data-status={row.draft ? 'draft' : 'confirmed'}
          >
            <h2>{row.name}</h2>
            <p className="eyebrow">{row.draft ? c(C.draft) : c(C.confirmed)}</p>
            <dl>
              <dt>{col('purposes')}</dt>
              <dd>{row.purposes.join('; ') || c(C.none)}</dd>
              <dt>{col('dataSubjects')}</dt>
              <dd>{row.dataSubjects.join('; ') || c(C.notYetAnswered)}</dd>
              <dt>{col('dataCategories')}</dt>
              <dd>{row.dataCategories.join('; ') || c(C.none)}</dd>
              <dt>{col('legalBases')}</dt>
              <dd>{row.legalBases.join('; ') || c(C.notYetAnswered)}</dd>
              <dt>{col('recipients')}</dt>
              <dd>{row.recipients.join('; ') || c(C.none)}</dd>
              <dt>{col('transfers')}</dt>
              <dd>{row.transfers.join(' ') || c(C.noTransfer)}</dd>
              <dt>{col('retention')}</dt>
              <dd data-retention="">{row.retention ?? c(C.notYetAnswered)}</dd>
              <dt>{col('evidence')}</dt>
              <dd className="mono">{row.evidence.join(', ') || c(C.none)}</dd>
            </dl>
            {row.draft ? (
              <form
                method="post"
                action={`${base}/register/${encodeURIComponent(row.activityId)}/confirm`}
                className="inline"
              >
                <label>
                  <Text of={t(locale, 'register.retention')} />{' '}
                  <input name="retention" maxLength={200} />
                </label>{' '}
                <button type="submit" className="btn">
                  <Text of={t(locale, 'register.confirm')} />
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ol>
    </article>
  );
}
