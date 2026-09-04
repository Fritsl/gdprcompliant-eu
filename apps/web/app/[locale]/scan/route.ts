import { startScan } from '@/lib/scan';
import { asLocale } from '@/lib/i18n';

// The front door's one action (U-02): a domain in, a scan started, the visitor sent to
// watch it. A refusal goes back to the front door with the reason, never with a stack
// trace, and never with a scan that was not started.

export const dynamic = 'force-dynamic';

function sourceOf(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? 'local';
}

export async function POST(request: Request, context: { params: Promise<{ locale: string }> }) {
  const locale = asLocale((await context.params).locale);
  if (!locale) return new Response('Not found', { status: 404 });
  const form = await request.formData();
  const domain = String(form.get('domain') ?? '');
  const outcome = await startScan({ domain, locale, source: sourceOf(request) });
  const url = new URL(request.url);
  url.search = '';
  if (outcome.ok) {
    url.pathname = `/${locale}/scan/${outcome.jobId}`;
    return Response.redirect(url.toString(), 303);
  }
  url.pathname = `/${locale}`;
  url.search = `?outcome=${outcome.reason}${outcome.retryAfter ? `&retry=${outcome.retryAfter}` : ''}`;
  const headers: Record<string, string> = { location: url.toString() };
  if (outcome.retryAfter) headers['retry-after'] = String(outcome.retryAfter);
  return new Response(null, { status: 303, headers });
}
