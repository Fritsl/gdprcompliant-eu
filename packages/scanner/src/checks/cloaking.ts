import {
  EvidenceSchema,
  SECURITY_CHECKS,
  SecurityObservationSchema,
  canonicalJson,
  sha256,
  type Evidence,
  type PassCapture,
  type SecurityObservation,
} from '@gc/contracts';
import { refTo, type EvidenceIdentity } from '../evidence.js';
import type { BrowserPool, ScanTarget } from '../pool.js';
import { vendorHostsOf } from '../passes/pass-bc.js';
import { SCANNER_USER_AGENT } from './exposed-paths.js';

// Cloaking (T-06): a site that serves a clean page to anything calling itself a scanner
// and the trackers to everyone else. The home page is loaded twice, once as an ordinary
// browser and once under the scanner's own declared User-Agent, and the third-party
// hosts each load contacted are compared. Hosts a browser gets that the declared scanner
// does not are the finding; the two host lists are the evidence.

export interface CloakingProbe {
  readonly observation: SecurityObservation;
  readonly evidence: readonly Evidence[];
}

const thirdParties = (own: string, hosts: Iterable<string>): string[] => {
  const bare = own.replace(/^www\./, '');
  return [...new Set(hosts)]
    .filter((h) => h !== own && h !== bare && !h.endsWith(`.${bare}`))
    .sort();
};

async function hostsSeen(
  pool: BrowserPool,
  target: ScanTarget,
): Promise<{ status: number; hosts: string[] }> {
  return pool.run(target, async (page) => {
    const hosts = new Set<string>();
    page.on('request', (r) => {
      try {
        hosts.add(new URL(r.url()).hostname.toLowerCase());
      } catch {
        // not a URL we can name
      }
    });
    let status = 0;
    try {
      const response = await page.goto(target.url, { waitUntil: 'load' });
      status = response?.status() ?? 0;
      await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
    } catch {
      status = 0;
    }
    return { status, hosts: [...hosts] };
  });
}

export async function probeCloaking(
  pool: BrowserPool,
  target: ScanTarget,
  options: { readonly identity: EvidenceIdentity; readonly capture?: PassCapture },
): Promise<CloakingProbe> {
  const own = new URL(target.url).hostname.toLowerCase();
  const asBrowser = options.capture
    ? { status: 200, hosts: vendorHostsOf(options.capture) }
    : await hostsSeen(pool, target);
  const asScanner = await hostsSeen(pool, { ...target, userAgent: SCANNER_USER_AGENT });
  const browserHosts = thirdParties(own, asBrowser.hosts);
  const declaredHosts = thirdParties(own, asScanner.hosts);
  const onlyForBrowsers = browserHosts.filter((h) => !declaredHosts.includes(h));
  const detail = {
    url: target.url,
    declaredUserAgent: SCANNER_USER_AGENT,
    browserHosts,
    declaredHosts,
    onlyForBrowsers,
    declaredStatus: asScanner.status,
  };
  const body = canonicalJson(detail);
  const hash = sha256(body);
  const row = EvidenceSchema.parse({
    id: `pass_diff:${hash.slice(0, 16)}`,
    tenantId: options.identity.tenantId,
    caseId: options.identity.caseId,
    ...(options.identity.scanId !== undefined ? { scanId: options.identity.scanId } : {}),
    kind: 'pass_diff',
    capturedAt: options.identity.capturedAt,
    source: { url: target.url, host: own },
    body,
    hash,
    caption: `third-party hosts on ${target.url}: a browser against a request declared as ${SCANNER_USER_AGENT}`,
  });
  const observe = (
    outcome: SecurityObservation['outcome'],
    summary: string,
    evidence: Evidence[],
  ): CloakingProbe => ({
    observation: SecurityObservationSchema.parse({
      check: 'cloaking',
      findingTypeId: SECURITY_CHECKS.cloaking,
      outcome,
      summary,
      detail,
      evidence: evidence.map((e) => refTo(e)),
    }),
    evidence,
  });
  if (asScanner.status === 0 || asScanner.status >= 400) {
    return observe(
      'undetermined',
      `${own} did not answer a request declared as ${SCANNER_USER_AGENT} (status ${asScanner.status}), so what it serves a scanner could not be compared.`,
      [row],
    );
  }
  if (onlyForBrowsers.length > 0) {
    return observe(
      'fail',
      `${own} loads ${onlyForBrowsers.length} third-party host(s) for a browser that it withholds from a request declared as ${SCANNER_USER_AGENT}: ${onlyForBrowsers.join(', ')}.`,
      [row],
    );
  }
  return observe(
    'pass',
    browserHosts.length === 0
      ? `${own} loads no third party for a browser or for a declared scanner.`
      : `${own} loads the same ${browserHosts.length} third-party host(s) for a browser and for a declared scanner.`,
    [row],
  );
}
