import { asLocale } from '@/lib/i18n';
import { answerForOwner } from '@/lib/questions';

// One answer (D-10): the option posted lands as the holder's answer, and the next screen
// says what it settled; a check returns at once with the job it queued.

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string; question: string }> },
) {
  const { locale: localeParam, token, question } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const form = await request.formData();
  const option = form.get('option');
  if (typeof option !== 'string') return new Response('Bad request', { status: 400 });
  const outcome = await answerForOwner(token, decodeURIComponent(question), option);
  if (!outcome.ok) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}/questions`;
  url.search = outcome.checkJobId
    ? `?checking=${encodeURIComponent(outcome.checkJobId)}`
    : outcome.settled.length > 0
      ? `?settled=${encodeURIComponent(outcome.settled.join(','))}`
      : '';
  return Response.redirect(url.toString(), 303);
}
