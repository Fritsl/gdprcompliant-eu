import type {
  ConsentFindingDraft,
  Evidence,
  FormObservation,
  PassDiff,
  PolicyDiscovery,
  ReplayObservation,
  SecurityObservation,
} from '@gc/contracts';
import { runSecurityChecks } from './checks/security.js';
import { inventoryForms } from './checks/forms.js';
import { detectReplay } from './checks/replay.js';
import { discoverPolicies } from './discovery/policies.js';
import { captureToEvidence, refTo, type EvidenceIdentity } from './evidence.js';
import { collectPassA } from './passes/pass-a.js';
import { collectPasses } from './passes/pass-bc.js';
import { diffPasses } from './passes/differ.js';
import type { QuietOptions } from './passes/network-quiet.js';
import type { BrowserPool, ScanTarget } from './pool.js';

// One place that runs the checks (C-05): all of them for a scan, or one family for a
// re-check of a single finding. A family is what a detector module needs to run again:
// the security surface, the form inventory, replay detection, policy discovery, or the
// three consent passes with their diff. The output is what assembly (S-14) reads, plus
// every evidence row the checks produced.

export const CHECK_FAMILIES = ['security', 'forms', 'replay', 'policies', 'consent'] as const;
export type CheckFamily = (typeof CHECK_FAMILIES)[number];

export interface RunChecksOptions {
  readonly identity: EvidenceIdentity;
  readonly families?: readonly CheckFamily[];
  readonly quiet?: Partial<QuietOptions>;
  readonly now?: () => Date;
}

export interface CheckOutput {
  readonly families: readonly CheckFamily[];
  readonly security?: readonly SecurityObservation[];
  readonly forms?: readonly FormObservation[];
  readonly replay?: readonly ReplayObservation[];
  readonly policies?: PolicyDiscovery;
  readonly consent?: readonly ConsentFindingDraft[];
  readonly diff?: PassDiff;
  readonly evidence: readonly Evidence[];
  readonly checksRun: number;
  readonly checksPassed: number;
  readonly undetermined: number;
  readonly durationMs: number;
}

export async function runChecks(
  pool: BrowserPool,
  target: ScanTarget,
  options: RunChecksOptions,
): Promise<CheckOutput> {
  const started = Date.now();
  const families = options.families ?? CHECK_FAMILIES;
  const evidence: Evidence[] = [];
  let checksRun = 0;
  let checksPassed = 0;
  let undetermined = 0;
  const out: {
    security?: SecurityObservation[];
    forms?: FormObservation[];
    replay?: ReplayObservation[];
    policies?: PolicyDiscovery;
    consent?: ConsentFindingDraft[];
    diff?: PassDiff;
  } = {};
  const count = (observations: readonly { outcome: string }[]) => {
    for (const o of observations) {
      checksRun += 1;
      if (o.outcome === 'pass') checksPassed += 1;
      if (o.outcome === 'undetermined') undetermined += 1;
    }
  };

  const wants = (f: CheckFamily) => families.includes(f);
  const quiet = options.quiet ? { quiet: options.quiet } : {};

  await Promise.all([
    (async () => {
      if (!wants('security')) return;
      const a = await collectPassA(pool, target, quiet);
      evidence.push(...captureToEvidence(a.capture, a.screenshot, options.identity));
      const surface = await runSecurityChecks(pool, target, {
        capture: a.capture,
        identity: options.identity,
      });
      out.security = [...surface.observations];
      evidence.push(...surface.evidence);
      count(surface.observations);
    })(),
    (async () => {
      if (!wants('forms')) return;
      const forms = await inventoryForms(pool, target, { identity: options.identity });
      out.forms = [...forms.inventory.observations];
      evidence.push(...forms.evidence);
      count(forms.inventory.observations);
    })(),
    (async () => {
      if (!wants('replay')) return;
      const replay = await detectReplay(pool, target, { identity: options.identity, ...quiet });
      out.replay = [...replay.report.observations];
      evidence.push(...replay.evidence);
      count(replay.report.observations);
    })(),
    (async () => {
      if (!wants('policies')) return;
      const found = await discoverPolicies(pool, target, {
        identity: options.identity,
        ...(options.now ? { now: options.now } : {}),
      });
      out.policies = found.discovery;
      evidence.push(...found.evidence);
      count([found.discovery.observation]);
    })(),
    (async () => {
      if (!wants('consent')) return;
      const all = await collectPasses(pool, target, {
        identity: options.identity,
        ...quiet,
        ...(options.now ? { now: options.now } : {}),
      });
      evidence.push(...captureToEvidence(all.b.capture, all.b.screenshot, options.identity));
      evidence.push(...captureToEvidence(all.c.capture, all.c.screenshot, options.identity));
      evidence.push(...all.b.evidence, ...all.c.evidence);
      const diffed = diffPasses({
        a: all.a.capture,
        b: all.b.capture,
        c: all.c.capture,
        refusal: all.b.refusal,
        identity: options.identity,
        refusalEvidence: all.b.evidence.map((e) => refTo(e)),
      });
      out.consent = [...diffed.drafts];
      out.diff = diffed.diff;
      evidence.push(...diffed.evidence);
      checksRun += 1;
      if (diffed.drafts.length === 0) checksPassed += 1;
      if (all.b.refusal.outcome === 'undetermined') undetermined += 1;
    })(),
  ]);

  // The same evidence row can come out of two checks; one copy is enough.
  const seen = new Set<string>();
  const unique = evidence.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  return {
    families,
    ...out,
    evidence: unique,
    checksRun,
    checksPassed,
    undetermined,
    durationMs: Date.now() - started,
  };
}
