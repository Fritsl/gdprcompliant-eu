import { notFound } from 'next/navigation';
import { Text } from '@/components/Text';
import { asLocale, t } from '@/lib/i18n';
import { supplyChainForToken } from '@/lib/supply-chain';

// The supply-chain map (D-08): the company, its processors and their sub-processors as
// the record holds them, drawn from the graph, with each node linking to the evidence
// that placed it, and the same map as an SVG, a PNG and a PDF to take elsewhere.

export const dynamic = 'force-dynamic';

export default async function SupplyChainPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale: localeParam, token } = await params;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const view = await supplyChainForToken(token, locale);
  if (!view) notFound();
  const base = `/${locale}/c/${token}`;
  return (
    <article
      className="screen supply-chain"
      data-nodes={view.model.nodes.length}
      data-omitted={view.model.omitted}
    >
      <p className="eyebrow">
        <a href={base} data-back="">
          <Text of={t(locale, 'supplyChain.back')} />
        </a>
      </p>
      <h1>{view.model.title}</h1>
      <Text of={t(locale, 'supplyChain.lead')} as="p" />
      <p className="actions">
        <a
          href={`${base}/supply-chain.svg`}
          download={`${view.caseId}-supply-chain.svg`}
          data-export="svg"
        >
          {'SVG'}
        </a>{' '}
        ·{' '}
        <a
          href={`${base}/supply-chain.png`}
          download={`${view.caseId}-supply-chain.png`}
          data-export="png"
        >
          {'PNG'}
        </a>{' '}
        ·{' '}
        <a
          href={`${base}/supply-chain.pdf`}
          download={`${view.caseId}-supply-chain.pdf`}
          data-export="pdf"
        >
          {'PDF'}
        </a>
      </p>
      <div
        className="map"
        style={{ overflowX: 'auto' }}
        data-map=""
        dangerouslySetInnerHTML={{ __html: view.svg }}
      />
      <h2>
        <Text of={t(locale, 'supplyChain.evidence')} />
      </h2>
      <ul className="evidence-list">
        {view.evidence.map((e) => (
          <li key={e.id} id={`evidence-${e.id}`} data-evidence-row={e.id}>
            <code>{e.id}</code> · {e.caption ?? e.kind} · {e.capturedAt.slice(0, 10)}
            {e.url ? (
              <>
                {' '}
                · <a href={e.url}>{e.url}</a>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </article>
  );
}
