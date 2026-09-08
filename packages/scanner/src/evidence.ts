import {
  EvidenceSchema,
  HostnameSchema,
  canonicalJson,
  sha256,
  type Evidence,
  type EvidenceRef,
  type PassCapture,
} from '@gc/contracts';

// A capture becomes evidence rows: one per request, cookie and storage write, one for
// the screenshot, and one summary of the hosts contacted. Each row's id and hash come
// from its body, so the same observation is the same row, and a finding that points at
// it by hash cannot point at something that was edited afterwards.

export interface EvidenceIdentity {
  readonly tenantId: string;
  readonly caseId: string;
  readonly scanId?: string;
  readonly capturedAt: string;
}

function row(
  identity: EvidenceIdentity,
  kind: Evidence['kind'],
  body: string,
  source: Evidence['source'],
  caption?: string,
): Evidence {
  const hash = sha256(body);
  return EvidenceSchema.parse({
    id: `${kind}:${hash.slice(0, 16)}`,
    tenantId: identity.tenantId,
    caseId: identity.caseId,
    ...(identity.scanId !== undefined ? { scanId: identity.scanId } : {}),
    kind,
    capturedAt: identity.capturedAt,
    source,
    body,
    hash,
    ...(caption !== undefined ? { caption } : {}),
  });
}

export function captureToEvidence(
  capture: PassCapture,
  screenshot: Uint8Array | undefined,
  identity: EvidenceIdentity,
): Evidence[] {
  const pageHost = hostOf(capture.finalUrl);
  const rows: Evidence[] = [];

  for (const request of capture.requests) {
    rows.push(
      row(
        identity,
        'http_request',
        canonicalJson(request),
        { url: request.url, host: request.host, pass: capture.pass },
        `${request.method} ${request.url} (${request.resourceType}) on pass ${capture.pass}`,
      ),
    );
  }
  for (const cookie of capture.cookies) {
    rows.push(
      row(
        identity,
        'cookie',
        canonicalJson(cookie),
        { host: cookie.domain.replace(/^\./, ''), pass: capture.pass },
        `cookie ${cookie.name} on ${cookie.domain} after pass ${capture.pass}`,
      ),
    );
  }
  for (const write of capture.storage) {
    // A sandboxed, srcdoc or about:blank frame has an opaque origin, which the browser
    // reports as the string "null". The write still happened in the visitor's browser,
    // so the row is kept, attributed to the page, and the caption says where it came from.
    const host = hostOf(write.origin);
    const opaque = !HostnameSchema.safeParse(host).success;
    rows.push(
      row(
        identity,
        'storage',
        canonicalJson(write),
        { host: opaque ? pageHost : host, pass: capture.pass },
        opaque
          ? `${write.area}Storage ${write.key} in a frame without an origin on ${pageHost} during pass ${capture.pass}`
          : `${write.area}Storage ${write.key} on ${write.origin} during pass ${capture.pass}`,
      ),
    );
  }
  if (screenshot) {
    rows.push(
      row(
        identity,
        'screenshot',
        Buffer.from(screenshot).toString('base64'),
        { url: capture.finalUrl, host: pageHost, pass: capture.pass },
        `full page after pass ${capture.pass}`,
      ),
    );
  }
  const hosts = [...new Set(capture.requests.map((r) => r.host))].sort();
  rows.push(
    row(
      identity,
      'text',
      hosts.join('\n'),
      { url: capture.finalUrl, host: pageHost, pass: capture.pass },
      `${hosts.length} hosts contacted on pass ${capture.pass}`,
    ),
  );
  return rows;
}

export function refTo(evidence: Evidence, quote?: string): EvidenceRef {
  return {
    evidenceId: evidence.id,
    hash: evidence.hash,
    ...(quote !== undefined ? { quote } : {}),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}
