import { deleteForToken } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// The hard delete (C-04): a POST from the case page, the case number typed back as
// confirmation. Afterwards the token resolves to nothing; the page that follows shows
// the one record that remains.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
) {
  const { locale: localeParam, token } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const form = await request.formData();
  const confirm = String(form.get('confirm') ?? '')
    .trim()
    .toUpperCase();
  const stub = await deleteForToken(token, confirm);
  if (!stub) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/deleted`;
  url.search = `?audit=${stub.id}&rows=${stub.rowsRemoved}`;
  return Response.redirect(url.toString(), 303);
}
