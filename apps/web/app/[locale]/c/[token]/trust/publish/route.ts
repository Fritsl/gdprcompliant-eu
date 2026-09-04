import { publishTrustForOwner } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// Publishing the public progress page (U-05): an explicit act by the holder, on the
// timeline, and back to the case where the link is shown.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
) {
  const { locale: localeParam, token } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const outcome = await publishTrustForOwner(token);
  if (!outcome) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}`;
  url.search = `?trust=${outcome}`;
  return Response.redirect(url.toString(), 303);
}
