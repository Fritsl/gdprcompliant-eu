import { asLocale } from '@/lib/i18n';
import { supplyChainForToken } from '@/lib/supply-chain';

// The supply-chain map as an SVG file (D-08): the same drawing the page shows.

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
  return new Response(view.svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'content-disposition': `attachment; filename="${view.caseId}-supply-chain.svg"`,
      'cache-control': 'no-store',
    },
  });
}
