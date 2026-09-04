import { notFound } from 'next/navigation';
import { Text } from '@/components/Text';
import { asLocale, t } from '@/lib/i18n';
import { ourselvesView } from '@/lib/ourselves';

// Our own record (O-01): what we process, who processes it for us, the public sources
// we read, how long everything is kept and how it is deleted; generated from the
// running configuration on every request.

export const dynamic = 'force-dynamic';

export default async function OurselvesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: localeParam } = await params;
  const locale = asLocale(localeParam);
  if (!locale) notFound();
  const v = ourselvesView(locale);
  const h = v.headings;
  return (
    <article className="screen narrow ourselves" data-generated={v.generatedAt}>
      <h1>{h['title']}</h1>
      <p>{v.lead}</p>
      <p className="mono">
        {v.controller.name} · {v.controller.contact} · {v.controller.country}
      </p>
      <p className="muted">
        <Text of={t(locale, 'ourselves.generated')} /> {v.generatedAt} ·{' '}
        <a href={`/${locale}/ourselves.md`} data-ourselves-download="">
          <Text of={t(locale, 'ourselves.download')} />
        </a>
      </p>

      <h2>{h['processing']}</h2>
      <ul>
        {v.processing.map((p) => (
          <li key={p.what}>
            {p.what} ({h['basis']}: {p.basis})
          </li>
        ))}
      </ul>

      <h2>{h['processors']}</h2>
      <ul>
        {v.processors.map((p) => (
          <li
            key={p.purpose}
            data-processor={p.purpose}
            data-status={p.pending ? 'pending' : 'contracted'}
          >
            <strong>{p.label}</strong>: {p.who}. {h['receives']}: {p.receives}. {h['basis']}:{' '}
            {p.basis}.
          </li>
        ))}
      </ul>

      <h2>{h['sources']}</h2>
      <p>{v.sourcesNote}</p>
      <ul>
        {v.sources.map((s) => (
          <li key={s.host} data-source={s.host}>
            {s.host}: {s.entity}, {s.country} ({s.purpose})
          </li>
        ))}
      </ul>

      <h2>{h['retention']}</h2>
      <table className="sig">
        <thead>
          <tr>
            <th>{h['table']}</th>
            <th>{h['rule']}</th>
          </tr>
        </thead>
        <tbody>
          {v.retention.map((r) => (
            <tr key={r.table} data-table={r.table}>
              <td>{r.table}</td>
              <td>{r.rule}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>{h['deletion']}</h2>
      <ol>
        {v.deletion.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>

      <h2>{h['ownCase']}</h2>
      {v.ownCaseUrl ? (
        <p>
          <a href={v.ownCaseUrl} data-own-case="">
            {v.ownCaseUrl}
          </a>
        </p>
      ) : (
        <p>
          <Text of={t(locale, 'ourselves.ownCase.none')} />
        </p>
      )}
    </article>
  );
}
