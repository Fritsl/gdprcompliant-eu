import { checkForOwner } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// "Check it again" on the case page (U-03): the finding's re-check goes to the agent's
// queue, and the holder of the token goes back to the case.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string; finding: string }> },
) {
  const { locale: localeParam, token, finding } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const ok = await checkForOwner(token, finding);
  if (!ok) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}`;
  url.search = '?checked=1';
  return Response.redirect(url.toString(), 303);
}
