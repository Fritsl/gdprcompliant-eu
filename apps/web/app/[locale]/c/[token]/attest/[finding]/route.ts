import { attestForOwner } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// "I have done this" (U-03, C-05): a finding whose remedy is verified by attestation
// closes on the holder's word, and the word is on the timeline.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string; finding: string }> },
) {
  const { locale: localeParam, token, finding } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const ok = await attestForOwner(token, finding);
  if (!ok) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}`;
  url.search = '?attested=1';
  return Response.redirect(url.toString(), 303);
}
