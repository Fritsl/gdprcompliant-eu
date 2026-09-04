import { createShareForOwner } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// A summary link for someone above the case (U-07): created by the holder, on the
// timeline, shown on the case page to hand over.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
) {
  const { locale: localeParam, token } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const form = await request.formData();
  const audience = String(form.get('audience') ?? '').trim();
  if (audience.length === 0 || audience.length > 80)
    return new Response('Bad request', { status: 400 });
  const shareId = await createShareForOwner(token, audience);
  if (!shareId) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}`;
  url.search = '?share=created';
  url.hash = 'upward';
  return Response.redirect(url.toString(), 303);
}
