import { unpublishTrustForOwner } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// Taking the public progress page down (U-05): as explicit as putting it up, and on the
// timeline the same way.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
) {
  const { locale: localeParam, token } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const outcome = await unpublishTrustForOwner(token);
  if (!outcome) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}`;
  url.search = `?trust=${outcome}`;
  return Response.redirect(url.toString(), 303);
}
