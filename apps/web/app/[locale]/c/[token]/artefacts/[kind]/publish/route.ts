import { ARTEFACT_KINDS, type ArtefactKind } from '@gc/contracts';
import { publishForOwner } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// Publishing is recorded, never performed here: the document leaves by export, and
// where it went is written on the timeline (A-09).

export const dynamic = 'force-dynamic';

const isKind = (k: string): k is ArtefactKind => (ARTEFACT_KINDS as readonly string[]).includes(k);

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string; kind: string }> },
) {
  const { locale: localeParam, token, kind } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale || !isKind(kind)) return new Response('Not found', { status: 404 });
  const form = await request.formData();
  const raw = form.get('url');
  const outcome = await publishForOwner(token, kind, {
    ...(typeof raw === 'string' ? { url: raw } : {}),
  });
  if (outcome === 'not_found') return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}/artefacts/${kind}`;
  url.search = `?outcome=${outcome === 'ok' ? 'published' : outcome}`;
  return Response.redirect(url.toString(), 303);
}
