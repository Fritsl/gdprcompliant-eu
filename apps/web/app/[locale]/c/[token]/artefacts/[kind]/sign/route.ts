import { ARTEFACT_KINDS, type ArtefactKind } from '@gc/contracts';
import { signForOwner } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// A person signs the version and the bytes they read (A-09). Anything else is stale, and
// the page says so.

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
  const outcome = await signForOwner(token, kind, {
    name: String(form.get('name') ?? ''),
    version: Number(form.get('version')),
    hash: String(form.get('hash') ?? ''),
  });
  if (outcome === 'not_found') return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}/artefacts/${kind}`;
  url.search = `?outcome=${outcome === 'ok' ? 'signed' : outcome}`;
  return Response.redirect(url.toString(), 303);
}
