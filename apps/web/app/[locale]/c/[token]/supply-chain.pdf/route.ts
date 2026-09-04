import { asLocale } from '@/lib/i18n';
import { supplyChainForToken, supplyChainPdfFor } from '@/lib/supply-chain';

// The supply-chain map as a PDF (D-08): landscape A4, greys only, from the same model
// as the page.

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
) {
  const { locale: localeParam, token } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const view = await supplyChainForToken(token, locale);
  if (!view) return new Response('Not found', { status: 404 });
  const pdf = await supplyChainPdfFor(view);
  return new Response(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${view.caseId}-supply-chain.pdf"`,
      'cache-control': 'no-store',
    },
  });
}
