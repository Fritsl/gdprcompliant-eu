import { signalsFromDocument } from '@gc/contracts';
import {
  SCAN_JOB,
  UnsupportedTarget,
  openCaseForTarget,
  assignLane,
  recordScan,
  seedRegister,
  seedSupplyChain,
  type Connection,
  type ScanPayload,
  type ScanProgress,
  type ScanStage,
  type StageMark,
} from '@gc/db';
import { assembleFindings, type AssemblyInput } from '@gc/findings';
import type { JobQueue } from '@gc/jobs';
import { event, span } from '@gc/telemetry';
import type { Catalogue } from '@gc/remedies';
import {
  captureToEvidence,
  collectPassA,
  collectPassB,
  collectPassC,
  diffPasses,
  discoverPolicies,
  inventoryForms,
  refTo,
  runSecurityChecks,
  type BrowserPool,
  type QuietOptions,
  checkAppListings,
  policyTextOf,
  recipientChecks,
  agreementDraft,
  discoverAgreement,
  resolveHost,
  resolveHosts,
  traverseSupplyChain,
  type AgreementDiscoveryResult,
  type SupplyChainResult,
} from '@gc/scanner';
import type { OutboundFetch } from '@gc/config';
import type { Evidence, SupplyChainLimits } from '@gc/contracts';

// The scan worker (U-02). One job per front-door request: reach the site, run the three
// passes and the checks, open the case in the target's own jurisdiction, record the
// scan, and hand back the case token. Every stage is checkpointed the moment it ends,
// with the mark the visitor will see: ok, could not tell, not needed, skipped, no
// response. A site that cannot be reached ends the scan at the first stage.

export interface ScanWorkerOptions {
  readonly pool: BrowserPool;
  readonly catalogue: Catalogue;
  readonly quiet?: Partial<QuietOptions>;
  readonly now?: () => Date;
  // The scheme to try first; the fixture estate serves https.
  readonly scheme?: 'https' | 'http';
  // The declared-endpoint fetch for app store listings (D-05); absent, no listing is read.
  readonly stores?: OutboundFetch;
  // Read the processing agreements the site's processors publish (D-06): at most this
  // many suppliers, through the same browser pool. Off unless asked for.
  readonly agreements?: number;
  // Walk the published sub-processor lists of the processors whose agreement was found
  // (D-07), within these limits. Off unless asked for.
  readonly subProcessors?: Partial<SupplyChainLimits>;
}

export async function registerScanWorker(
  queue: JobQueue,
  connection: Connection,
  options: ScanWorkerOptions,
): Promise<void> {
  await queue.work(SCAN_JOB, async (job) => {
    try {
      await span(
        'scan.job',
        { jobId: job.id, domain: job.payload.domain, attempt: job.attempt },
        () => scan(job),
        { traceId: job.id },
      );
    } catch (e) {
      console.error(`scan job ${job.id} failed:`, e);
      throw e;
    }
  });

  async function scan(
    job: Parameters<Parameters<typeof queue.work<ScanPayload, ScanProgress>>[1]>[0],
  ): Promise<void> {
    const now = job.payload.now
      ? () => new Date(job.payload.now!)
      : (options.now ?? (() => new Date()));
    const progress: ScanProgress = { stages: [] };
    const mark = async (stage: ScanStage, m: StageMark, detail?: string): Promise<void> => {
      const existing = progress.stages.findIndex((s) => s.stage === stage);
      const state = { stage, mark: m, at: now().toISOString(), ...(detail ? { detail } : {}) };
      event('scan.stage', { scanId: job.id, ...state }, { traceId: job.id });
      if (existing >= 0) progress.stages[existing] = state;
      else progress.stages.push(state);
      await job.checkpoint({ ...progress, stages: [...progress.stages] });
    };
    const finish = async (outcome: ScanProgress['outcome'], extra: Partial<ScanProgress> = {}) => {
      Object.assign(progress, extra, { outcome });
      await job.checkpoint({ ...progress, stages: [...progress.stages] });
    };

    const domain = job.payload.domain;
    const url = `${options.scheme ?? 'https'}://${domain}/`;
    // Evidence is captured before the case exists; its rows are re-homed when the scan is
    // recorded. The placeholder has the shape a case number has.
    const identity = {
      tenantId: 'pending',
      caseId: 'XX-00-XXXX',
      scanId: job.id,
      capturedAt: now().toISOString(),
    };
    const quiet = options.quiet ? { quiet: options.quiet } : {};

    // 1. Reach the site: Pass A.
    await mark('opening', 'on');
    let a: Awaited<ReturnType<typeof collectPassA>>;
    try {
      a = await collectPassA(options.pool, { url }, quiet);
    } catch (e) {
      await mark('opening', 'fail', (e as Error).message.slice(0, 200));
      for (const s of [
        'first-load',
        'banner',
        'refusing',
        'after-refusal',
        'accepting',
        'policy',
        'recipients',
        'security',
        'writing-up',
      ] as const) {
        await mark(s, 'skip');
      }
      await finish('unreachable');
      return;
    }
    if (a.capture.status !== undefined && a.capture.status >= 400) {
      await mark('opening', 'fail', `HTTP ${a.capture.status}`);
      await finish('unreachable');
      return;
    }
    await mark('opening', 'ok');
    await mark('first-load', 'ok', `${new Set(a.capture.requests.map((r) => r.host)).size} hosts`);

    // 2. The banner and the refusal: Pass B, then the acceptance: Pass C.
    await mark('banner', 'on');
    const evidence: Evidence[] = captureToEvidence(a.capture, a.screenshot, identity);
    const b = await collectPassB(options.pool, { url }, { identity, ...quiet, now });
    evidence.push(...captureToEvidence(b.capture, b.screenshot, identity), ...b.evidence);
    const refusal = b.refusal;
    if (refusal.outcome === 'no_banner') {
      await mark('banner', 'na', 'no banner');
      await mark('refusing', 'na');
      await mark('after-refusal', 'na');
      await mark('accepting', 'na');
    } else {
      await mark('banner', 'ok', `${refusal.platform ?? 'banner'} found`);
      await mark(
        'refusing',
        refusal.outcome === 'refused' ? 'ok' : 'undet',
        refusal.summary.slice(0, 200),
      );
      await mark('after-refusal', refusal.outcome === 'refused' ? 'ok' : 'skip');
      await mark('accepting', 'on');
    }
    const c = await collectPassC(options.pool, { url }, { identity, ...quiet, now });
    evidence.push(...captureToEvidence(c.capture, c.screenshot, identity), ...c.evidence);
    if (refusal.outcome !== 'no_banner') {
      await mark('accepting', c.capture.consent?.outcome === 'accepted' ? 'ok' : 'undet');
    }
    const diffed = diffPasses({
      a: a.capture,
      b: b.capture,
      c: c.capture,
      refusal,
      identity,
      refusalEvidence: b.evidence.map((e) => refTo(e)),
    });
    evidence.push(...diffed.evidence);

    // 3. The policy, the recipients, the security surface.
    await mark('policy', 'on');
    const policies = await discoverPolicies(options.pool, { url }, { identity, now });
    evidence.push(...policies.evidence);
    // The app, if the site links to one (D-05): what the store says it collects, against
    // the policy the discovery just read.
    const policyText = policyTextOf(policies);
    const apps = options.stores
      ? await checkAppListings(
          {
            links: policies.homeLinks,
            host: domain,
            identity,
            ...(policyText
              ? {
                  policyText: policyText.text,
                  policyUrl: policyText.url,
                  policyEvidence: policyText.evidence,
                }
              : {}),
            now,
          },
          options.stores,
        )
      : undefined;
    if (apps) evidence.push(...apps.evidence);
    // The suppliers' agreements (D-06): every resolved processor the site talks to, read
    // at the site its own terms are published on.
    const agreements: AgreementDiscoveryResult[] = [];
    if (options.agreements) {
      const seen = new Set<string>();
      for (const r of resolveHosts(c.vendorHosts)) {
        if (r.resolution !== 'resolved' || r.entry.role !== 'processor' || seen.has(r.entry.id))
          continue;
        seen.add(r.entry.id);
        if (seen.size > options.agreements) break;
        agreements.push(
          await discoverAgreement(
            options.pool,
            { url: `${new URL(r.entry.provenance.url).origin}/` },
            { identity, vendorName: r.entry.label, now },
          ),
        );
      }
      for (const a of agreements) evidence.push(...a.evidence);
    }
    // Their sub-processors, and theirs (D-07): one walk per supplier that published an
    // agreement, at the walk's own pace, written to the graph once the case is open.
    const chains: SupplyChainResult[] = [];
    if (options.subProcessors) {
      for (const a of agreements) {
        if (a.discovery.outcome !== 'found') continue;
        const chain = await traverseSupplyChain(
          options.pool,
          { url: `https://${a.discovery.vendor.host}/` },
          {
            identity,
            ...(a.discovery.vendor.name ? { vendorName: a.discovery.vendor.name } : {}),
            limits: options.subProcessors,
            now,
          },
        );
        chains.push(chain);
        evidence.push(...chain.evidence);
      }
    }
    await mark(
      'policy',
      policies.discovery.observation.outcome === 'pass' ? 'ok' : 'undet',
      policies.discovery.observation.summary.slice(0, 200),
    );
    const recipients = recipientChecks(a.capture, identity);
    evidence.push(...recipients.evidence);
    await mark(
      'recipients',
      recipients.observations.some((o) => o.outcome === 'fail') ? 'undet' : 'ok',
      `${c.vendorHosts.length} third-party host(s)`,
    );
    await mark('security', 'on');
    const surface = await runSecurityChecks(
      options.pool,
      { url },
      { capture: a.capture, identity },
    );
    const forms = await inventoryForms(options.pool, { url }, { identity });
    evidence.push(...surface.evidence, ...forms.evidence);
    await mark(
      'security',
      'ok',
      `${surface.observations.filter((o) => o.outcome === 'pass').length} of ${surface.observations.length} passed`,
    );

    // 4. The case, in the target's own jurisdiction, and the record of the scan.
    await mark('writing-up', 'on');
    let opened;
    try {
      opened = await openCaseForTarget(connection, {
        ...(job.payload.referredBy ? { referredBy: job.payload.referredBy } : {}),
        signals: signalsFromDocument(domain, a.capture.document),
        source: 'scanner',
        now,
      });
    } catch (e) {
      if (e instanceof UnsupportedTarget) {
        await mark('writing-up', 'fail', e.message.slice(0, 200));
        await finish('unreachable');
        return;
      }
      throw e;
    }
    const input: AssemblyInput = {
      security: surface.observations,
      recipients: recipients.observations,
      forms: forms.inventory.observations,
      policies: policies.discovery,
      consent: diffed.drafts,
      drafts: [
        ...(apps?.drafts ?? []),
        ...agreements.flatMap((a) => {
          const d = agreementDraft(a, domain);
          return d ? [d] : [];
        }),
      ],
    };
    const assembled = assembleFindings(input, {
      tenantId: opened.tenantId,
      caseId: opened.caseId,
      jurisdiction: opened.target.jurisdiction as 'DK' | 'DE',
      catalogue: options.catalogue,
      host: domain,
      scanId: job.id,
      now,
    });
    await recordScan(connection, opened.tenantId, opened.caseId, {
      scanId: job.id,
      kind: 'initial',
      findings: assembled.findings,
      evidence: evidence.map((e) => ({ ...e, tenantId: opened.tenantId, caseId: opened.caseId })),
      checksRun: surface.observations.length + forms.inventory.observations.length + 2,
      checksPassed:
        surface.observations.filter((o) => o.outcome === 'pass').length +
        forms.inventory.observations.filter((o) => o.outcome === 'pass').length +
        (policies.discovery.observation.outcome === 'pass' ? 1 : 0) +
        (diffed.drafts.length === 0 ? 1 : 0),
      undetermined: refusal.outcome === 'undetermined' ? 1 : 0,
      actor: { kind: 'scanner' },
      now: now(),
    });
    // The register's first draft, read from what the scan saw (G-01).
    await seedRegister(connection, opened.tenantId, opened.caseId, {
      scanId: job.id,
      now: now(),
      forms: forms.inventory,
      recipients: recipients.observations,
      consent: diffed.drafts,
    });
    for (const c of chains) {
      await seedSupplyChain(connection, opened.tenantId, opened.caseId, {
        chain: c.chain,
        scanId: job.id,
        now: now(),
        resolve: (h) => resolveHost(h),
      });
    }
    // The lane (L-01): scored from what was seen, stored, never shown to the customer.
    await assignLane(connection, opened.tenantId, opened.caseId);
    await mark('writing-up', 'ok', `${assembled.findings.length} finding(s)`);
    const outcome: ScanProgress['outcome'] =
      refusal.outcome === 'undetermined'
        ? 'no_refusal'
        : refusal.outcome === 'no_banner' && diffed.drafts.length === 0
          ? 'no_banner_needed'
          : 'case';
    await finish(outcome, {
      caseToken: opened.accessToken,
      caseId: opened.caseId,
      findings: assembled.findings.length,
    });
  }
}
