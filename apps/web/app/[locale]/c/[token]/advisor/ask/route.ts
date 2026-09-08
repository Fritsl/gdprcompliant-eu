import { adviseForOwner } from '@/lib/advisor';
import { asLocale } from '@/lib/i18n';
import { redirectTo } from '@/lib/redirect';

// One question to the advisor (V-02): answered from the case and the law, recorded on
// the timeline, and back to the advisor page where the answer now stands.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
) {
  const { locale: localeParam, token } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const form = await request.formData();
  const question = form.get('question');
  if (typeof question !== 'string') return new Response('Bad request', { status: 400 });
  const thread = form.get('thread');
  const result = await adviseForOwner(
    token,
    question,
    locale,
    typeof thread === 'string' && thread ? thread : undefined,
  );
  if (result.outcome === 'not_found') return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}/advisor`;
  url.search = `?outcome=${result.outcome}${result.thread ? `&thread=${encodeURIComponent(result.thread)}` : ''}`;
  return redirectTo(url);
}
