import { asLocale } from '@/lib/i18n';
import { confirmForOwner } from '@/lib/register';

// The holder confirms a register row (G-01), answering the retention as they do; the
// drafts it replaces are superseded on the graph, and the page shows the row confirmed.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string; activity: string }> },
) {
  const { locale: localeParam, token, activity } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const form = await request.formData();
  const retention = form.get('retention');
  const ok = await confirmForOwner(token, decodeURIComponent(activity), {
    ...(typeof retention === 'string' ? { retention } : {}),
  });
  if (!ok) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}/register`;
  url.search = '?confirmed=1';
  return Response.redirect(url.toString(), 303);
}
