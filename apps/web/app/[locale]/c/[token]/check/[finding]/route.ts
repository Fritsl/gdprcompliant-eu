import { checkForOwner } from '@/lib/case';
import { asLocale } from '@/lib/i18n';
import { redirectTo } from '@/lib/redirect';

// "Check it again" on the case page (U-04): a re-check job for the worker, and the
// holder of the token goes back to the case, where the outcome is reported as it lands.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string; finding: string }> },
) {
  const { locale: localeParam, token, finding } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const jobId = await checkForOwner(token, finding);
  if (!jobId) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}`;
  url.search = `?recheck=${encodeURIComponent(jobId)}`;
  url.hash = finding;
  return redirectTo(url);
}
