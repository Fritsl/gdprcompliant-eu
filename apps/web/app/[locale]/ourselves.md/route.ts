import { asLocale } from '@/lib/i18n';
import { ourselvesView } from '@/lib/ourselves';

// Our own record as a document (O-01): the same content the page shows, as Markdown.

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ locale: string }> }) {
  const { locale: localeParam } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const view = ourselvesView(locale);
  return new Response(view.markdown, {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `inline; filename="ourselves-${locale}.md"`,
    },
  });
}
