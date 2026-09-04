import sharp from 'sharp';
import { asLocale } from '@/lib/i18n';
import { supplyChainForToken } from '@/lib/supply-chain';

// The supply-chain map as a PNG (D-08): the SVG rasterised at twice its size, on white,
// so it reads on a slide or in a message; greys only, so it prints as it shows.

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
  const png = await sharp(Buffer.from(view.svg), { density: 144 })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  return new Response(new Uint8Array(png), {
    headers: {
      'content-type': 'image/png',
      'content-disposition': `attachment; filename="${view.caseId}-supply-chain.png"`,
      'cache-control': 'no-store',
    },
  });
}
