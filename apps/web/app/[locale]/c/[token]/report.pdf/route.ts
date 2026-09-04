import { reportForToken } from '@/lib/report';
import { asLocale } from '@/lib/i18n';

// The status report as a PDF (V-01), generated from the case as it stands right now.

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
) {
  const { locale: localeParam, token } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const report = await reportForToken(token, locale);
  if (!report) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(report.pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${report.caseId}-status-report.pdf"`,
      'cache-control': 'no-store',
    },
  });
}
