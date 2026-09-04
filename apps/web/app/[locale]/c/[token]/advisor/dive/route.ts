import { diveForOwner } from '@/lib/advisor';
import { asLocale } from '@/lib/i18n';

// A dive (V-05): the element posts its kind, its reference and its text; turn zero is
// seeded from them, or the conversation the element came from gets one more turn; then
// back to that conversation on the advisor page.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
) {
  const { locale: localeParam, token } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const form = await request.formData();
  const kind = form.get('kind');
  const ref = form.get('ref');
  const fragment = form.get('fragment');
  const thread = form.get('thread');
  if (typeof kind !== 'string' || typeof ref !== 'string' || typeof fragment !== 'string')
    return new Response('Bad request', { status: 400 });
  const result = await diveForOwner(
    token,
    { kind, ref, fragment, ...(typeof thread === 'string' && thread ? { thread } : {}) },
    locale,
  );
  if (result.outcome === 'not_found') return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}/advisor`;
  url.search = `?outcome=${result.outcome}${result.thread ? `&thread=${encodeURIComponent(result.thread)}` : ''}`;
  return Response.redirect(url.toString(), 303);
}
