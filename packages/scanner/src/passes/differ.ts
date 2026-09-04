import {
  CONSENT_FINDINGS,
  EvidenceSchema,
  PassDiffSchema,
  canonicalJson,
  sha256,
  type CapturedRequest,
  type ConsentFindingDraft,
  type ConsentRefusal,
  type Evidence,
  type EvidenceRef,
  type HostDiff,
  type HostRole,
  type PassCapture,
  type PassDiff,
} from '@gc/contracts';
import { refTo, type EvidenceIdentity } from '../evidence.js';

// The three-pass differ (S-05): the wedge. Pass A says what loads before anyone is
// asked; Pass B what still loads after a refusal; Pass C what loads once everything is
// allowed. Every third-party host is judged on what it was seen doing, and the findings
// name the hosts and carry the diff as evidence. A site that behaves produces nothing.

export interface DifferInput {
  readonly a: PassCapture;
  readonly b: PassCapture;
  readonly c: PassCapture;
  readonly refusal: ConsentRefusal;
  readonly identity: EvidenceIdentity;
  // Screenshots of the refusal path, for the findings about the path itself.
  readonly refusalEvidence?: readonly EvidenceRef[];
}

export interface DifferResult {
  readonly diff: PassDiff;
  readonly drafts: readonly ConsentFindingDraft[];
  readonly evidence: readonly Evidence[];
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
};

const pathOf = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

const TRACKING_PATH =
  /(^|\/)(collect|track|tracking|pixel|beacon|event|events|analytics|pageview|hit|impression|conversion|log|ping|px|p\.gif|1x1)(\/|\?|\.|$)/i;

const sameSite = (host: string, site: string): boolean => {
  const bare = site.replace(/^www\./, '');
  return host === site || host === bare || host.endsWith(`.${bare}`);
};

interface HostActivity {
  requests: CapturedRequest[];
  identifiers: Set<string>;
}

// Per host: what it requested and which identifiers came out of it, on one pass. An
// identifier is attributed to the host that served the script that wrote it (by
// initiator chain), or to the host the cookie was set for.
function activity(capture: PassCapture, site: string): Map<string, HostActivity> {
  const out = new Map<string, HostActivity>();
  const get = (host: string): HostActivity => {
    let a = out.get(host);
    if (!a) {
      a = { requests: [], identifiers: new Set() };
      out.set(host, a);
    }
    return a;
  };
  for (const r of capture.requests) get(r.host).requests.push(r);
  // Cookies set for a third-party domain belong to that host.
  for (const c of capture.cookies) {
    const domain = c.domain.replace(/^\./, '').toLowerCase();
    if (!sameSite(domain, site)) get(domain).identifiers.add(`cookie:${c.name}`);
  }
  // First-party cookies and storage written by a third-party script belong to the
  // script's host: the chain of the requests that script initiated tells who was busy.
  const thirdPartyScripts = capture.requests.filter(
    (r) => r.resourceType === 'script' && !sameSite(r.host, site),
  );
  for (const script of thirdPartyScripts) {
    const initiated = capture.requests.filter((r) => r.chain.includes(script.url));
    const wroteSomething =
      initiated.length > 0 ||
      capture.cookies.some((c) => sameSite(c.domain.replace(/^\./, ''), site)) ||
      capture.storage.length > 0;
    if (!wroteSomething) continue;
    for (const c of capture.cookies) {
      const domain = c.domain.replace(/^\./, '').toLowerCase();
      if (sameSite(domain, site)) get(script.host).identifiers.add(`cookie:${c.name}`);
    }
    for (const w of capture.storage) {
      if (w.atMs >= 0) get(script.host).identifiers.add(`${w.area}:${w.key}`);
    }
  }
  return out;
}

function roleOf(
  host: string,
  site: string,
  consentHosts: ReadonlySet<string>,
  acts: readonly (HostActivity | undefined)[],
): { role: HostRole; signals: string[] } {
  if (sameSite(host, site)) return { role: 'first-party', signals: [] };
  if (consentHosts.has(host)) return { role: 'consent-platform', signals: [] };
  const signals = new Set<string>();
  for (const a of acts) {
    if (!a) continue;
    for (const r of a.requests) {
      const path = pathOf(r.url);
      if (TRACKING_PATH.test(path)) signals.add(`reports to ${pathOf(r.url).split('?')[0]}`);
      if (r.resourceType === 'image' && path.includes('?'))
        signals.add('loads a pixel with parameters');
      if (r.resourceType === 'script' && a.identifiers.size > 0) {
        signals.add(`its script wrote ${[...a.identifiers].sort().join(', ')}`);
      }
    }
    for (const id of a.identifiers) if (id.startsWith('cookie:')) signals.add(`sets ${id}`);
  }
  return signals.size > 0
    ? { role: 'tracking', signals: [...signals].sort() }
    : { role: 'other', signals: [] };
}

// The hosts whose scripts render the banner: those the refusal's own steps ran in, and
// the hosts of scripts that were loaded on every pass and wrote the consent record.
function consentPlatformHosts(input: DifferInput, site: string): Set<string> {
  const hosts = new Set<string>();
  for (const step of input.refusal.steps) if (step.frame) hosts.add(hostOf(step.frame));
  const record = new Set([
    ...(input.b.consent?.recordedIn.cookies ?? []).map((n) => `cookie:${n}`),
    ...(input.b.consent?.recordedIn.storage ?? []),
  ]);
  if (record.size === 0) return hosts;
  // A third-party script present on all passes that requested nothing that tracks, on a
  // page where a consent record was written, is the platform.
  const everywhere = input.a.requests
    .filter((r) => r.resourceType === 'script' && !sameSite(r.host, site))
    .filter(
      (r) =>
        input.b.requests.some((x) => x.host === r.host) &&
        input.c.requests.some((x) => x.host === r.host),
    );
  for (const r of everywhere) {
    const anyTracking = [input.a, input.b, input.c].some((cap) =>
      cap.requests.some(
        (x) =>
          x.host === r.host &&
          (TRACKING_PATH.test(pathOf(x.url)) ||
            (x.resourceType === 'image' && x.url.includes('?'))),
      ),
    );
    if (!anyTracking) hosts.add(r.host);
  }
  return hosts;
}

export function diffPasses(input: DifferInput): DifferResult {
  const site = hostOf(input.a.finalUrl);
  const acts = {
    a: activity(input.a, site),
    b: activity(input.b, site),
    c: activity(input.c, site),
  };
  const consentHosts = consentPlatformHosts(input, site);
  const allHosts = [...new Set([...acts.a.keys(), ...acts.b.keys(), ...acts.c.keys()])].sort();

  const hosts: HostDiff[] = allHosts.map((host) => {
    const { role, signals } = roleOf(host, site, consentHosts, [
      acts.a.get(host),
      acts.b.get(host),
      acts.c.get(host),
    ]);
    return {
      host,
      role,
      signals,
      onFirstLoad: acts.a.has(host),
      afterRefusal: acts.b.has(host),
      afterAcceptance: acts.c.has(host),
      identifiers: {
        a: [...(acts.a.get(host)?.identifiers ?? [])].sort(),
        b: [...(acts.b.get(host)?.identifiers ?? [])].sort(),
        c: [...(acts.c.get(host)?.identifiers ?? [])].sort(),
      },
    };
  });
  const tracking = hosts.filter((h) => h.role === 'tracking');
  const refused = input.refusal.outcome === 'refused';
  const steps = input.refusal.steps;
  const interactions = steps.filter((s) => s.action !== 'found' && s.action !== 'hidden').length;
  const togglesOff = steps.filter((s) => s.action === 'toggle_off').length;
  const clicks = steps.filter((s) => s.action === 'click').length;
  const layers = refused ? Math.max(1, clicks) : 0;

  const diff = PassDiffSchema.parse({
    site,
    hosts,
    beforeInteraction: tracking.filter((h) => h.onFirstLoad).map((h) => h.host),
    ignoringRefusal: refused
      ? tracking.filter((h) => h.afterRefusal && h.afterAcceptance).map((h) => h.host)
      : [],
    gated: tracking.filter((h) => !h.afterRefusal && h.afterAcceptance).map((h) => h.host),
    refusal: {
      made: refused,
      outcome: input.refusal.outcome,
      interactions,
      togglesOff,
      layers,
      remembered: input.b.consent?.rememberedAfterReload ?? false,
    },
  });

  // The diff itself is the evidence every finding here points at.
  const body = canonicalJson(diff);
  const hash = sha256(body);
  const identical = diff.ignoringRefusal.length;
  const diffRow = EvidenceSchema.parse({
    id: `pass_diff:${hash.slice(0, 16)}`,
    tenantId: input.identity.tenantId,
    caseId: input.identity.caseId,
    ...(input.identity.scanId ? { scanId: input.identity.scanId } : {}),
    kind: 'pass_diff',
    capturedAt: input.identity.capturedAt,
    source: { host: site },
    body,
    hash,
    caption: `Pass B (reject all) vs Pass C (accept all) — ${identical} host${identical === 1 ? '' : 's'} identical`,
  });
  const diffRef = refTo(diffRow);
  const pathRefs = input.refusalEvidence ?? [];

  const drafts: ConsentFindingDraft[] = [];
  if (diff.beforeInteraction.length > 0) {
    drafts.push({
      typeId: CONSENT_FINDINGS.beforeInteraction,
      hosts: diff.beforeInteraction,
      summary: `${diff.beforeInteraction.length} tracking host${diff.beforeInteraction.length === 1 ? '' : 's'} contacted on the first load, before any interaction: ${diff.beforeInteraction.join(', ')}.`,
      evidence: [diffRef],
    });
  }
  if (diff.ignoringRefusal.length > 0) {
    drafts.push({
      typeId: CONSENT_FINDINGS.refusalIgnored,
      hosts: diff.ignoringRefusal,
      summary: `Refusing changed nothing for ${diff.ignoringRefusal.length} tracking host${diff.ignoringRefusal.length === 1 ? '' : 's'}: contacted after the refusal exactly as after acceptance: ${diff.ignoringRefusal.join(', ')}.`,
      evidence: [diffRef],
    });
  }
  if (input.refusal.outcome === 'undetermined') {
    drafts.push({
      typeId: CONSENT_FINDINGS.noRefusalPath,
      hosts: [],
      summary: input.refusal.summary,
      evidence: [diffRef, ...pathRefs],
    });
  }
  if (refused && input.b.consent && !input.b.consent.rememberedAfterReload) {
    drafts.push({
      typeId: CONSENT_FINDINGS.choiceNotRemembered,
      hosts: [],
      summary:
        'The refusal closed the banner, and on the next page load the banner asked again: nothing was stored to remember it.',
      evidence: [diffRef, ...pathRefs],
    });
  }
  if (refused && steps.some((s) => s.action === 'save')) {
    drafts.push({
      typeId: CONSENT_FINDINGS.noRejectOnFirstLayer,
      hosts: [],
      summary: `There is no way to refuse on the first layer; refusing took ${interactions} interaction${interactions === 1 ? '' : 's'} through the settings, while accepting takes one.`,
      evidence: [diffRef, ...pathRefs],
    });
  }
  if (refused && togglesOff > 0) {
    drafts.push({
      typeId: CONSENT_FINDINGS.preTickedToggles,
      hosts: [],
      summary: `${togglesOff} optional categor${togglesOff === 1 ? 'y was' : 'ies were'} switched on before the visitor chose anything.`,
      evidence: [diffRef, ...pathRefs],
    });
  }
  if (refused && interactions > 3) {
    drafts.push({
      typeId: CONSENT_FINDINGS.refusalBuried,
      hosts: [],
      summary: `Refusing took ${interactions} interactions across ${layers} layer${layers === 1 ? '' : 's'}.`,
      evidence: [diffRef, ...pathRefs],
    });
  }
  return { diff, drafts, evidence: [diffRow] };
}
