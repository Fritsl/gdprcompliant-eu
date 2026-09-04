import { asLocale } from '@/lib/i18n';
import { registerMarkdownForOwner } from '@/lib/register';

// The record of processing activities as a document (G-01), in the visitor's language.

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
) {
  const { locale: localeParam, token } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const doc = await registerMarkdownForOwner(token, locale);
  if (!doc) return new Response('Not found', { status: 404 });
  return new Response(doc.markdown, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${doc.caseId}-register.md"`,
      'cache-control': 'no-store',
    },
  });
}
