import { revokeForToken } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// The owner withdraws an invitation (P-02): the link stops working now.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string; member: string }> },
) {
  const { locale: localeParam, token, member } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const outcome = await revokeForToken(token, member);
  if (outcome === 'not_found') return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}`;
  url.search = outcome === 'ok' ? '' : `?outcome=${outcome}`;
  return Response.redirect(url.toString(), 303);
}
