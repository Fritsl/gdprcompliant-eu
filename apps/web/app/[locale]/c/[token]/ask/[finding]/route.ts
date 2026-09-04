import { askForOwner } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// "Ask for an answer" on a remedy with none (U-04, R-05): one row in the demand ledger,
// and back to the case.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string; finding: string }> },
) {
  const { locale: localeParam, token, finding } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const ok = await askForOwner(token, finding);
  if (!ok) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}`;
  url.search = '?asked=1';
  url.hash = finding;
  return Response.redirect(url.toString(), 303);
}
