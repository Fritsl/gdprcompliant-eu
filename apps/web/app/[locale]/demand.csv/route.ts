import { demandCsv } from '@gc/db';
import { loadRankedDemand } from '@/lib/demand';
import { asLocale } from '@/lib/i18n';

// The same ranked view as the page, as a file (R-05).

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ locale: string }> }) {
  if (!asLocale((await context.params).locale)) return new Response('Not found', { status: 404 });
  const rows = await loadRankedDemand();
  return new Response(demandCsv(rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="demand.csv"',
      'cache-control': 'no-store',
    },
  });
}
