import { exportForToken } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// Everything about the case as one file (C-04), for the token holder.

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
) {
  const { locale: localeParam, token } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const result = await exportForToken(token, locale);
  if (!result) return new Response('Not found', { status: 404 });
  return new Response(result.json, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${result.caseId}.json"`,
      'x-content-sha256': result.sha256,
      'cache-control': 'no-store',
    },
  });
}
