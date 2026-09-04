import {
  SECURITY_CHECKS,
  SecurityObservationSchema,
  canonicalJson,
  type Evidence,
  type PassCapture,
  type SecurityCheckId,
  type SecurityObservation,
} from '@gc/contracts';
import type { APIRequestContext, APIResponse } from 'playwright';
import { captureToEvidence, refTo, type EvidenceIdentity } from '../evidence.js';
import { EvidenceSchema } from '@gc/contracts';
import { sha256 } from '@gc/contracts';
import type { BrowserPool, ScanTarget } from '../pool.js';
import { EXPOSED_PATHS, SCANNER_USER_AGENT, robotsDisallows } from './exposed-paths.js';
import { evaluateHsts, evaluateReferrerPolicy, evaluateSecurityHeaders, lower } from './headers.js';
import { probeCloaking } from './cloaking.js';

// The security surface a stranger can see. Every check is a deterministic reading of
// responses the site gave to ordinary requests: GET only, no body, no credentials, one
// request per URL, same host only. Rules for the path probe: docs/decisions/exposed-paths.md.

export interface SecuritySurface {
  readonly observations: readonly SecurityObservation[];
  readonly evidence: readonly Evidence[];
}

export interface SecurityOptions {
  // A Pass A capture of the same target, for mixed content and referrer exposure. Without
  // one the check loads the page itself, briefly.
  readonly capture?: PassCapture;
  readonly identity: EvidenceIdentity;
}

interface Probe {
  readonly url: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly location?: string;
  readonly failed?: string;
}

async function probe(request: APIRequestContext, url: string): Promise<Probe> {
  let response: APIResponse;
  try {
    response = await request.get(url, {
      maxRedirects: 0,
      headers: { 'user-agent': SCANNER_USER_AGENT },
      timeout: 10_000,
    });
  } catch (e) {
    return {
      url,
      status: 0,
      headers: {},
      body: '',
      failed: (e as Error).message.split('\n')[0] ?? 'failed',
    };
  }
  const headers = lower(response.headers());
  const body =
    response.ok() || response.status() < 400 ? (await response.text()).slice(0, 64 * 1024) : '';
  return {
    url,
    status: response.status(),
    headers,
    body,
    ...(headers['location'] !== undefined ? { location: headers['location'] } : {}),
  };
}

function probeEvidence(identity: EvidenceIdentity, p: Probe, caption: string): Evidence {
  const body = canonicalJson({
    url: p.url,
    status: p.status,
    headers: p.headers,
    location: p.location,
    failed: p.failed,
    bodyStart: p.body.slice(0, 512),
  });
  const hash = sha256(body);
  const host = new URL(p.url).hostname;
  return EvidenceSchema.parse({
    id: `header:${hash.slice(0, 16)}`,
    tenantId: identity.tenantId,
    caseId: identity.caseId,
    ...(identity.scanId !== undefined ? { scanId: identity.scanId } : {}),
    kind: 'header',
    capturedAt: identity.capturedAt,
    source: { url: p.url, host },
    body,
    hash,
    caption,
  });
}

export async function runSecurityChecks(
  pool: BrowserPool,
  target: ScanTarget,
  options: SecurityOptions,
): Promise<SecuritySurface> {
  const origin = new URL(target.url);
  const host = origin.hostname;
  const httpsRoot = `https://${host}/`;
  const httpRoot = `http://${host}/`;
  const { identity } = options;

  const surface = await pool.run(target, async (page, context) => {
    const request = context.request;
    const evidence: Evidence[] = [];
    const observations: SecurityObservation[] = [];
    const observe = (
      check: SecurityCheckId,
      outcome: SecurityObservation['outcome'],
      summary: string,
      detail: Record<string, unknown>,
      refs: Evidence[],
    ) => {
      evidence.push(...refs.filter((e) => !evidence.some((x) => x.hash === e.hash)));
      observations.push(
        SecurityObservationSchema.parse({
          check,
          findingTypeId: SECURITY_CHECKS[check],
          outcome,
          summary,
          detail,
          evidence: refs.map((e) => refTo(e)),
        }),
      );
    };

    // 1. Transport: is there TLS, and does plain HTTP lead to it?
    const https = await probe(request, httpsRoot);
    const http = await probe(request, httpRoot);
    const httpsEv = probeEvidence(identity, https, `GET ${httpsRoot}`);
    const httpEv = probeEvidence(identity, http, `GET ${httpRoot}`);
    const tlsWorks = https.status > 0 && https.status < 400;
    const httpRedirectsToTls =
      http.status >= 300 && http.status < 400 && (http.location ?? '').startsWith('https://');
    if (!tlsWorks) {
      observe(
        'transport',
        'fail',
        `${host} does not answer over HTTPS (${https.failed ?? `HTTP ${https.status}`}).`,
        { https: https.status, httpsFailed: https.failed },
        [httpsEv, httpEv],
      );
    } else if (http.status > 0 && http.status < 400 && !httpRedirectsToTls) {
      observe(
        'transport',
        'fail',
        `${host} serves pages over plain HTTP without sending the visitor to HTTPS.`,
        { http: http.status, https: https.status },
        [httpEv, httpsEv],
      );
    } else {
      observe(
        'transport',
        'pass',
        `${host} answers over HTTPS and plain HTTP leads there.`,
        { http: http.status, https: https.status, location: http.location },
        [httpEv, httpsEv],
      );
    }

    // 2. HSTS, on the HTTPS answer.
    if (tlsWorks) {
      const hsts = evaluateHsts(https.headers);
      if (!hsts.present)
        observe(
          'hsts',
          'fail',
          `${host} sends no Strict-Transport-Security header, so browsers will try plain HTTP again next time.`,
          { ...hsts },
          [httpsEv],
        );
      else if (!hsts.adequate)
        observe(
          'hsts',
          'fail',
          `${host} sends Strict-Transport-Security with max-age ${hsts.maxAge ?? 'missing'}; a year is the floor.`,
          { ...hsts },
          [httpsEv],
        );
      else
        observe(
          'hsts',
          'pass',
          `${host} sends Strict-Transport-Security for at least a year.`,
          { ...hsts },
          [httpsEv],
        );
    } else {
      observe('hsts', 'undetermined', 'No HTTPS answer to read the header from.', {}, []);
    }

    // 3. Security headers, on the page the visitor actually gets.
    const pageProbe = tlsWorks ? https : http;
    const pageEv = tlsWorks ? httpsEv : httpEv;
    const headers = evaluateSecurityHeaders(pageProbe.headers);
    if (headers.missing.length > 0)
      observe(
        'security_headers',
        'fail',
        `${host} is missing ${headers.missing.join(', ')}.`,
        { ...headers },
        [pageEv],
      );
    else
      observe(
        'security_headers',
        'pass',
        `${host} sends the expected security headers.`,
        { ...headers },
        [pageEv],
      );

    // 4. Forms: where do they post, and does an http action bounce to https?
    const pageUrl = tlsWorks ? httpsRoot : httpRoot;
    await page.goto(pageUrl, { waitUntil: 'load' });
    const forms = (await page.evaluate(FORMS_SCRIPT)) as {
      action: string;
      method: string;
      fields: string[];
    }[];
    const metaReferrer = (await page.evaluate(META_REFERRER_SCRIPT)) as string | undefined;
    const insecure: { action: string; fields: string[]; redirect?: string; status?: number }[] = [];
    const formEvidence: Evidence[] = [];
    for (const form of forms) {
      let action: URL;
      try {
        action = new URL(form.action, pageUrl);
      } catch {
        continue;
      }
      if (action.protocol !== 'http:') continue;
      // One GET, no body: does the plain-HTTP action bounce to HTTPS?
      const p = await probe(request, action.toString());
      const ev = probeEvidence(identity, p, `GET ${action} (form action, no payload)`);
      formEvidence.push(ev);
      insecure.push({
        action: action.toString(),
        fields: form.fields,
        ...(p.location ? { redirect: p.location } : {}),
        status: p.status,
      });
    }
    if (insecure.length > 0) {
      observe(
        'form_downgrade',
        'fail',
        `${insecure.length} form(s) on ${host} post over plain HTTP: ${insecure.map((f) => f.action).join(', ')}.`,
        { forms: insecure },
        formEvidence,
      );
    } else {
      observe(
        'form_downgrade',
        'pass',
        forms.length === 0
          ? `No forms on ${pageUrl}.`
          : `Every form on ${pageUrl} posts over HTTPS.`,
        { forms: forms.map((f) => f.action) },
        [],
      );
    }

    // 5. Mixed content and 6. referrer exposure, from the capture.
    const capture = options.capture;
    const captureRows = capture ? captureToEvidence(capture, undefined, identity) : [];
    const summaryRow = captureRows.find((r) => r.kind === 'text');
    if (capture && tlsWorks) {
      const mixed = capture.requests.filter((r) => r.url.startsWith('http://'));
      if (capture.finalUrl.startsWith('https://') && mixed.length > 0) {
        observe(
          'mixed_content',
          'fail',
          `${mixed.length} resource(s) load over plain HTTP on an HTTPS page: ${[...new Set(mixed.map((r) => r.host))].join(', ')}.`,
          { urls: mixed.map((r) => r.url) },
          captureRows.filter(
            (r) =>
              r.kind === 'http_request' &&
              mixed.some((m) => m.url === (JSON.parse(r.body) as { url: string }).url),
          ),
        );
      } else if (capture.finalUrl.startsWith('https://')) {
        observe(
          'mixed_content',
          'pass',
          `Every resource on ${capture.finalUrl} loads over HTTPS.`,
          {},
          [],
        );
      } else {
        observe(
          'mixed_content',
          'undetermined',
          'The capture was of the plain-HTTP page.',
          { finalUrl: capture.finalUrl },
          [],
        );
      }
      const thirdParties = [
        ...new Set(capture.requests.map((r) => r.host).filter((h) => h !== host)),
      ];
      const referrer = evaluateReferrerPolicy(https.headers, metaReferrer);
      if (referrer.leaks && thirdParties.length > 0) {
        observe(
          'referrer_policy',
          'fail',
          `${host} sets no protective Referrer-Policy, and ${thirdParties.length} other host(s) receive the full page address with every request.`,
          { policy: referrer.policy, thirdParties },
          summaryRow ? [httpsEv, summaryRow] : [httpsEv],
        );
      } else {
        observe(
          'referrer_policy',
          'pass',
          referrer.leaks
            ? `${host} sets no Referrer-Policy, but nothing loads from another host.`
            : `${host} sends Referrer-Policy ${referrer.policy}.`,
          { policy: referrer.policy, thirdParties },
          [],
        );
      }
    } else {
      observe(
        'mixed_content',
        'undetermined',
        tlsWorks ? 'No capture to read requests from.' : 'No HTTPS page.',
        {},
        [],
      );
      observe(
        'referrer_policy',
        'undetermined',
        tlsWorks ? 'No capture to read requests from.' : 'No HTTPS page.',
        {},
        [],
      );
    }

    // 7. Exposed paths, within the documented rules.
    const robots = await probe(request, new URL('/robots.txt', pageUrl).toString());
    const robotsText = robots.status === 200 ? robots.body : '';
    const exposed: { path: string; looksLike: string }[] = [];
    const skipped: string[] = [];
    const pathEvidence: Evidence[] = [];
    for (const candidate of EXPOSED_PATHS) {
      if (robotsText && robotsDisallows(robotsText, candidate.path)) {
        skipped.push(candidate.path);
        continue;
      }
      const p = await probe(request, new URL(candidate.path, pageUrl).toString());
      if (p.status === 200 && candidate.matches(p.body, p.headers['content-type'] ?? '')) {
        exposed.push({ path: candidate.path, looksLike: candidate.looksLike });
        pathEvidence.push(
          probeEvidence(identity, p, `GET ${candidate.path}: ${candidate.looksLike}`),
        );
      }
    }
    if (exposed.length > 0)
      observe(
        'exposed_paths',
        'fail',
        `${exposed.length} file(s) on ${host} are public that never should be: ${exposed.map((e) => e.path).join(', ')}.`,
        { exposed, skippedByRobots: skipped, probed: EXPOSED_PATHS.length - skipped.length },
        pathEvidence,
      );
    else
      observe(
        'exposed_paths',
        'pass',
        `None of the ${EXPOSED_PATHS.length - skipped.length} paths probed on ${host} is public.`,
        { skippedByRobots: skipped, probed: EXPOSED_PATHS.length - skipped.length },
        [],
      );

    return { observations, evidence };
  });

  // 8. Cloaking: the same page as a browser and as a declared scanner (T-06). Its own
  // passes, so it runs after the request-level checks have released the context.
  const cloak = await probeCloaking(pool, target, {
    identity,
    ...(options.capture ? { capture: options.capture } : {}),
  });
  return {
    observations: [...surface.observations, cloak.observation],
    evidence: [
      ...surface.evidence,
      ...cloak.evidence.filter((e) => !surface.evidence.some((x) => x.hash === e.hash)),
    ],
  };
}

const FORMS_SCRIPT = `Array.from(document.forms).map((f) => ({
  action: f.getAttribute('action') || location.href,
  method: (f.getAttribute('method') || 'get').toLowerCase(),
  fields: Array.from(f.elements).map((e) => e.name).filter(Boolean),
}))`;

const META_REFERRER_SCRIPT = `(document.querySelector('meta[name="referrer"]') || {}).content || undefined`;
