import { remindForToken } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// A reminder to a colleague who has not finished (P-02): once a day at most.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string; member: string }> },
) {
  const { locale: localeParam, token, member } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const outcome = await remindForToken(token, member, locale);
  if (outcome === 'not_found') return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}`;
  url.search = outcome === 'ok' ? '' : `?outcome=${outcome}`;
  return Response.redirect(url.toString(), 303);
}
