import { ARTEFACT_KINDS, type ArtefactKind } from '@gc/contracts';
import { generateForOwner } from '@/lib/case';

// Write a draft from the register (G-02), then back to the preview with the outcome.

export const dynamic = 'force-dynamic';

const isKind = (k: string): k is ArtefactKind => (ARTEFACT_KINDS as readonly string[]).includes(k);

export async function POST(
  _request: Request,
  context: { params: Promise<{ locale: string; token: string; kind: string }> },
) {
  const { locale, token, kind } = await context.params;
  if (!isKind(kind)) return new Response('Not found', { status: 404 });
  const outcome = await generateForOwner(token, kind);
  if (outcome === 'not_found') return new Response('Not found', { status: 404 });
  return Response.redirect(
    new URL(`/${locale}/c/${token}/artefacts/${kind}?outcome=${outcome}`, _request.url),
    303,
  );
}
