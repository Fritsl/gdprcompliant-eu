import { packForToken } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// The evidence pack (G-04) for the token holder: a zip of plain files, dated now.

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
) {
  const { locale: localeParam, token } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const result = await packForToken(token, locale);
  if (!result) return new Response('Not found', { status: 404 });
  const body = result.zip.buffer.slice(
    result.zip.byteOffset,
    result.zip.byteOffset + result.zip.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${result.caseId}-evidence-pack.zip"`,
      'x-content-sha256': result.sha256,
      'cache-control': 'no-store',
    },
  });
}
