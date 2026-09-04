import { revokeShareForOwner } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// Revoking a summary link (U-07): the link answers nothing from now on, and the
// revocation is on the timeline like the creation was.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string; share: string }> },
) {
  const { locale: localeParam, token, share } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const ok = await revokeShareForOwner(token, share);
  if (!ok) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}`;
  url.search = '?share=revoked';
  url.hash = 'upward';
  return Response.redirect(url.toString(), 303);
}
