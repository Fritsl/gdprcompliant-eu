import { ARTEFACT_KINDS, type ArtefactKind } from '@gc/contracts';
import { exportArtefactForOwner } from '@/lib/case';

// The signed document's bytes, with the signature in the headers. Unsigned, nothing leaves.

export const dynamic = 'force-dynamic';

const isKind = (k: string): k is ArtefactKind => (ARTEFACT_KINDS as readonly string[]).includes(k);

export async function GET(
  _request: Request,
  context: { params: Promise<{ locale: string; token: string; kind: string }> },
) {
  const { token, kind } = await context.params;
  if (!isKind(kind)) return new Response('Not found', { status: 404 });
  const doc = await exportArtefactForOwner(token, kind);
  if (!doc) return new Response('Not found', { status: 404 });
  return new Response(doc.content, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${kind}-v${doc.version}.md"`,
      'x-artefact-version': String(doc.version),
      'x-artefact-hash': doc.hash,
      'x-artefact-signed-by': encodeURIComponent(doc.signedBy.name),
      'x-artefact-signed-at': doc.signedAt,
      'cache-control': 'no-store',
    },
  });
}
