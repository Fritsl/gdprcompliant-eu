import { timelineModel, timelinePdf } from '@gc/artefacts';
import { loadCaseByToken } from '@/lib/case';
import { asLocale, t } from '@/lib/i18n';

// The accountability record as a dated PDF (C-02), for the token holder.

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
) {
  const { locale: localeParam, token } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const view = await loadCaseByToken(token);
  if (!view) return new Response('Not found', { status: 404 });
  const model = timelineModel(view.caseId, view.events, { locale });
  const page = t(locale, 'timeline.page').text;
  const pdf = await timelinePdf(model, {
    title: t(locale, 'timeline.heading').text,
    generatedAt: new Date(),
    generatedLabel: t(locale, 'timeline.generated').text,
    pageLabel: (p, n) => page.replace('{{page}}', String(p)).replace('{{pages}}', String(n)),
  });
  return new Response(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${view.caseId}-timeline.pdf"`,
      'cache-control': 'no-store',
    },
  });
}
