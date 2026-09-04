import { deepScanForOwner } from '@/lib/deep-scan';
import { asLocale } from '@/lib/i18n';

// "Look deeper" on a claimed case (T-09): one job for the worker, and back to the case,
// which reads the job while it runs.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
) {
  const { locale: localeParam, token } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const result = await deepScanForOwner(token);
  if (result.outcome === 'not_found') return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}`;
  url.search =
    result.outcome === 'queued' && result.jobId
      ? `?deep=${encodeURIComponent(result.jobId)}`
      : `?outcome=${result.outcome}`;
  return Response.redirect(url.toString(), 303);
}
