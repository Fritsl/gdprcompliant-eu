import { notFound } from 'next/navigation';
import { Text } from '@/components/Text';
import { loadRankedDemand } from '@/lib/demand';
import { asLocale, t } from '@/lib/i18n';

// The demand ledger, ranked (R-05). Counts only; the database function behind it never
// returns a group small enough to point at one company.

export const dynamic = 'force-dynamic';

const day = (iso: string) => iso.slice(0, 10);

export default async function Demand({ params }: { params: Promise<{ locale: string }> }) {
  const locale = asLocale((await params).locale);
  if (!locale) notFound();
  const rows = await loadRankedDemand();
  const all = t(locale, 'demand.all').text;
  return (
    <article className="demand">
      <Text of={t(locale, 'demand.heading')} as="h1" />
      <Text of={t(locale, 'demand.lead')} as="p" />
      {rows.length === 0 ? (
        <Text of={t(locale, 'demand.empty')} as="p" />
      ) : (
        <>
          <p>
            <a href={`/${locale}/demand.csv`} download="demand.csv">
              <Text of={t(locale, 'demand.download')} />
            </a>
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">
                    <Text of={t(locale, 'demand.col.finding')} />
                  </th>
                  <th scope="col">
                    <Text of={t(locale, 'demand.col.jurisdiction')} />
                  </th>
                  <th scope="col">
                    <Text of={t(locale, 'demand.col.country')} />
                  </th>
                  <th scope="col">
                    <Text of={t(locale, 'demand.col.sector')} />
                  </th>
                  <th scope="col">
                    <Text of={t(locale, 'demand.col.headcount')} />
                  </th>
                  <th scope="col">
                    <Text of={t(locale, 'demand.col.tenants')} />
                  </th>
                  <th scope="col">
                    <Text of={t(locale, 'demand.col.cases')} />
                  </th>
                  <th scope="col">
                    <Text of={t(locale, 'demand.col.first')} />
                  </th>
                  <th scope="col">
                    <Text of={t(locale, 'demand.col.last')} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.findingTypeId}</td>
                    <td>{r.jurisdiction}</td>
                    <td>{r.country ?? all}</td>
                    <td>{r.sector ?? all}</td>
                    <td>{r.headcountBand ?? all}</td>
                    <td>{r.tenants}</td>
                    <td>{r.cases}</td>
                    <td>{day(r.firstSeenAt)}</td>
                    <td>{day(r.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </article>
  );
}
