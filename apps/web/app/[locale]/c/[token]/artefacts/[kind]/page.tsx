import { notFound } from 'next/navigation';
import { ARTEFACT_KINDS, type ArtefactKind } from '@gc/contracts';
import { Text } from '@/components/Text';
import { loadArtefact } from '@/lib/case';
import { asLocale, t } from '@/lib/i18n';
import type { Locale } from '@gc/contracts';

// A generated document, previewed before it is published anywhere (U-04, A-09): the
// exact bytes, the version and the hash a person signs, then publish and export. No
// signature, no export; a changed document, a new signature.

export const dynamic = 'force-dynamic';

const isKind = (k: string): k is ArtefactKind => (ARTEFACT_KINDS as readonly string[]).includes(k);

function kindLabel(kind: ArtefactKind, locale: Locale) {
  switch (kind) {
    case 'privacy_policy':
      return t(locale, 'artefact.kind.privacyPolicy');
    case 'cookie_declaration':
      return t(locale, 'artefact.kind.cookieDeclaration');
    case 'processing_agreement':
      return t(locale, 'artefact.kind.processingAgreement');
    case 'processing_register':
      return t(locale, 'artefact.kind.processingRegister');
    case 'sub_processor_list':
      return t(locale, 'artefact.kind.subProcessorList');
    case 'retention_schedule':
      return t(locale, 'artefact.kind.retentionSchedule');
    case 'evidence_pack':
      return t(locale, 'artefact.kind.evidencePack');
    case 'status_report':
      return t(locale, 'artefact.kind.statusReport');
  }
}

// Trace comments name the graph rows a paragraph came from (G-02); a reader sees the text.
const paragraphs = (content: string) =>
  content
    .split('\n')
    .filter((l) => !l.startsWith('<!-- trace:'))
    .join('\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

export default async function ArtefactPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; token: string; kind: string }>;
  searchParams: Promise<{ outcome?: string }>;
}) {
  const { locale: localeParam, token, kind } = await params;
  const locale = asLocale(localeParam);
  if (!locale || !isKind(kind)) notFound();
  const view = await loadArtefact(token, kind);
  if (!view) notFound();
  const base = `/${locale}/c/${token}`;
  const here = `${base}/artefacts/${kind}`;
  const { outcome } = await searchParams;
  const noticeText = {
    signed: t(locale, 'artefact.signedNow'),
    generated: t(locale, 'artefact.generatedNow'),
    published: t(locale, 'artefact.publishedNow'),
    stale: t(locale, 'artefact.stale'),
    unsigned: t(locale, 'artefact.unsigned'),
    invalid: t(locale, 'artefact.invalid'),
  };
  const notice =
    outcome === 'signed' ||
    outcome === 'generated' ||
    outcome === 'published' ||
    outcome === 'stale' ||
    outcome === 'unsigned' ||
    outcome === 'invalid'
      ? noticeText[outcome]
      : undefined;
  const doc = view.document;
  const when = (iso: string): string => {
    return iso.slice(0, 16).replace('T', ' ');
  };

  return (
    <article
      className="artefact screen narrow"
      data-kind={kind}
      data-status={doc?.status ?? 'none'}
    >
      <p>
        <a href={base} className="lnk">
          ‹ <Text of={t(locale, 'artefact.back')} /> {view.caseId}
        </a>
      </p>
      <p className="eyebrow">
        <Text of={t(locale, 'artefact.eyebrow')} />
      </p>
      <h1 className="plan-lead">
        <Text of={kindLabel(kind, locale)} />
      </h1>
      {notice ? (
        <p
          role={
            outcome === 'stale' || outcome === 'unsigned' || outcome === 'invalid'
              ? 'alert'
              : 'status'
          }
        >
          <Text of={notice} />
        </p>
      ) : null}
      {view.gaps && view.gaps.length > 0 ? (
        <section className="gaps" data-gaps={view.gaps.length}>
          <Text of={t(locale, 'artefact.gaps')} as="h3" />
          <ul>
            {view.gaps.map((g, i) => (
              <li key={i} data-gap={g.code}>
                {g.text}
              </li>
            ))}
          </ul>
        </section>
      ) : view.gaps ? (
        <form method="post" action={`${here}/generate`} className="inline" data-generate="">
          {doc ? (
            <button type="submit" className="btn-2">
              <Text of={t(locale, 'artefact.regenerate')} />
            </button>
          ) : (
            <button type="submit" className="btn">
              <Text of={t(locale, 'artefact.generate')} />
            </button>
          )}
        </form>
      ) : null}
      {!doc ? (
        <Text of={t(locale, 'artefact.none')} as="p" />
      ) : (
        <div className="doc">
          <div className="doc-h">
            <Text of={kindLabel(kind, locale)} as="h3" />
            <div className="sub">
              <Text of={t(locale, 'artefact.version')} /> {doc.version} ·{' '}
              <span className="mono">{doc.hash.slice(0, 12)}</span> ·{' '}
              <Text of={t(locale, 'artefact.generated')} />{' '}
              <time dateTime={doc.generatedAt}>{when(doc.generatedAt)}</time>
            </div>
            {doc.signedBy && doc.signedAt ? (
              <div className="from" data-signed="">
                <Text of={t(locale, 'artefact.signed')} /> {doc.signedBy} ·{' '}
                <time dateTime={doc.signedAt}>{when(doc.signedAt)}</time>
              </div>
            ) : null}
            {doc.publishedAt ? (
              <div className="from" data-published="">
                <Text of={t(locale, 'artefact.published')} />{' '}
                <time dateTime={doc.publishedAt}>{when(doc.publishedAt)}</time>
                {doc.publishedUrl ? <> · {doc.publishedUrl}</> : null}
              </div>
            ) : null}
          </div>
          <div className="doc-s doc-body">
            {paragraphs(doc.content).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
          <div className="doc-sign">
            {doc.status === 'draft' ? (
              <form method="post" action={`${here}/sign`} className="inline">
                <input type="hidden" name="version" value={doc.version} />
                <input type="hidden" name="hash" value={doc.hash} />
                <label>
                  <Text of={t(locale, 'artefact.signer')} />{' '}
                  <input name="name" autoComplete="name" required maxLength={80} />
                </label>{' '}
                <button type="submit" className="btn">
                  <Text of={t(locale, 'artefact.sign')} />
                </button>
                <span className="note">
                  <Text of={t(locale, 'artefact.signNote')} /> v{doc.version} ·{' '}
                  <span className="mono">{doc.hash.slice(0, 12)}</span>
                </span>
              </form>
            ) : null}
            {doc.status === 'signed' ? (
              <form method="post" action={`${here}/publish`} className="inline">
                <label>
                  <Text of={t(locale, 'artefact.publishUrl')} />{' '}
                  <input name="url" type="url" autoComplete="off" />
                </label>{' '}
                <button type="submit" className="btn">
                  <Text of={t(locale, 'artefact.publish')} />
                </button>
              </form>
            ) : null}
            {doc.status !== 'draft' ? (
              <a
                href={`${here}/export`}
                download={`${kind}-v${doc.version}.md`}
                className="btn btn-2"
              >
                <Text of={t(locale, 'artefact.export')} />
              </a>
            ) : null}
          </div>
        </div>
      )}
    </article>
  );
}
