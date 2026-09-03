import { checkForMember } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// "I do not know, check it for me" (P-01): the item's proposal goes to the agent's
// queue, and the colleague goes back to their list.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; invite: string; finding: string }> },
) {
  const { locale: localeParam, invite, finding } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const ok = await checkForMember(invite, finding, locale);
  if (!ok) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/m/${invite}`;
  url.search = '?checked=1';
  return Response.redirect(url.toString(), 303);
}
