import { Dispatcher, createWorkers, plan, type ModelClient, type PlannerInput } from '@gc/agent';
import {
  AGREEMENT_FINDINGS,
  type Finding,
  type FindingTypeId,
  type SupplyChainLimits,
} from '@gc/contracts';
import {
  DEEP_SCAN_JOB,
  DEEP_SCAN_REFUSED,
  appendCaseEvent,
  caseAnswers,
  caseForPlanner,
  deepScanAuthorisation,
  findingsForCase,
  graphOf,
  recordScan,
  registerRows,
  seedSupplyChain,
  siteFactSources,
  supplierHosts,
  withTenant,
  type Connection,
  type DeepScanProgress,
} from '@gc/db';
import { assembleFindings } from '@gc/findings';
import type { JobQueue } from '@gc/jobs';
import type { Catalogue } from '@gc/remedies';
import {
  answerFacts,
  evaluate,
  factsFrom,
  loadQuestions,
  loadRuleSets,
  loadSectors,
} from '@gc/rules';
import {
  agreementDraft,
  discoverAgreement,
  resolveHost,
  traverseSupplyChain,
  type AgreementDiscoveryResult,
  type BrowserPool,
  type SupplyChainResult,
} from '@gc/scanner';

// The deep scan (T-09 journey 3): the planner's run over a claimed case. It refuses
// without the owner's proof of control or a public-interest decision (D-11); plans from
// the case as it stands, the heuristic sequence or the model's when one is configured
// (A-06), and puts the plan's rationale on the timeline in a line a person can read;
// then does the deep parts the plan calls for and the workers can do without a person:
// reads every supplier's published processing agreement (D-06) and walks the
// sub-processor lists of those that publish one (D-07); and records what it found as
// a scan of its own kind, reconciling only the contract findings, so nothing the
// ordinary scan raised is touched.

export interface DeepScanWorkerOptions {
  readonly pool: BrowserPool;
  readonly catalogue: Catalogue;
  // At most this many suppliers' agreements per run.
  readonly agreements?: number;
  readonly subProcessors?: Partial<SupplyChainLimits>;
  readonly model?: ModelClient;
  readonly now?: () => Date;
  readonly scheme?: 'https' | 'http';
}

const sets = loadRuleSets();
const questions = loadQuestions();
const sectors = loadSectors();

export async function registerDeepScanWorker(
  queue: JobQueue,
  connection: Connection,
  options: DeepScanWorkerOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const scheme = options.scheme ?? 'https';
  await queue.work(DEEP_SCAN_JOB, async (job) => {
    const { tenantId, caseId } = job.payload;
    const report = (p: DeepScanProgress) => job.checkpoint({ ...p, at: now().toISOString() });

    const c = await caseForPlanner(connection, tenantId, caseId);
    if (!c) {
      await report({ outcome: 'failed', detail: 'no such case' });
      return;
    }
    const deep = await deepScanAuthorisation(connection, tenantId, caseId);
    if (!deep.allowed) {
      await report({ outcome: 'refused', detail: deep.reason || DEEP_SCAN_REFUSED });
      return;
    }
    const domain = c.company.domain;
    await report({ stage: 'planning' });

    // 1. The plan, from the case as it stands.
    const [rows, site, answers, findings, graph] = await Promise.all([
      registerRows(connection, tenantId, caseId),
      siteFactSources(connection, tenantId, caseId),
      caseAnswers(connection, tenantId, caseId),
      findingsForCase(connection, tenantId, caseId),
      withTenant(connection, tenantId, (db) => graphOf(db, caseId)),
    ]);
    const facts = factsFrom({
      company: c.company,
      rows,
      findingTypeIds: site.findingTypeIds,
      ...(site.cookies ? { cookies: site.cookies } : {}),
      answers: answerFacts(
        questions,
        answers.map((a) => ({ questionId: a.questionId, optionId: a.answer })),
      ),
      sectors,
    }).facts;
    const duties = evaluate(sets, { caseId, jurisdiction: c.jurisdiction, facts }).map((d) => ({
      ruleId: d.ruleId,
      title: d.title[c.locale] ?? d.title['en'] ?? d.ruleId,
      status: d.status,
      findingTypeIds: d.findingTypeIds,
    }));
    const suppliers = supplierHosts(graph, domain);
    const open = findings.filter((f) => f.status === 'open');
    const input: PlannerInput = {
      case: c,
      openFindingTypeIds: open.map((f) => f.typeId as FindingTypeId),
      duties,
      budget: { credits: 100 },
      availableTypes: [
        'crawl',
        'read_contract',
        'registry_lookup',
        'research',
        'draft',
        'verify_claims',
      ],
      state: {
        scanned: site.findingTypeIds.length > 0 || findings.length > 0,
        registerRows: rows.length,
        registerConfirmed: rows.filter((r) => !r.draft).length,
        unresolvedVendors: suppliers.filter((s) => s.unresolved).length,
      },
    };
    const dispatcher = new Dispatcher({
      budgets: { perCase: 1000, perScan: 100 },
      workers: createWorkers({}),
      now,
    });
    const outcome = await plan(input, {
      dispatcher,
      ...(options.model ? { model: options.model } : {}),
    });
    await report({
      stage: 'reading suppliers',
      plan: outcome.rationales.map((r) => ({ type: r.type, rationale: r.rationale.slice(0, 300) })),
      source: outcome.source,
      suppliers: suppliers.length,
    });
    await withTenant(connection, tenantId, (db) =>
      appendCaseEvent(db, {
        tenantId,
        caseId,
        at: now(),
        actor: { kind: 'agent', name: 'planner' },
        type: 'note_added',
        payload: {
          text: [
            `Deep scan planned (${outcome.source}${outcome.escalated ? ', escalated' : ''}): ${outcome.rationales.length} task(s).`,
            ...outcome.rationales.map((r) => `${r.type}: ${r.rationale}`),
          ].join('\n'),
        },
      }),
    );

    // 2. The suppliers' agreements, and the sub-processors of those that publish one.
    const identity = { tenantId, caseId, scanId: job.id, capturedAt: now().toISOString() };
    const results: AgreementDiscoveryResult[] = [];
    const chains: SupplyChainResult[] = [];
    const limit = options.agreements ?? 6;
    for (const s of suppliers.slice(0, limit)) {
      try {
        results.push(
          await discoverAgreement(
            options.pool,
            { url: `${scheme}://${s.host}/` },
            { identity, vendorName: s.name, now },
          ),
        );
      } catch (e) {
        await report({
          stage: 'reading suppliers',
          detail: `${s.host}: ${(e as Error).message}`.slice(0, 300),
        });
      }
    }
    if (options.subProcessors) {
      for (const a of results) {
        if (a.discovery.outcome !== 'found') continue;
        try {
          chains.push(
            await traverseSupplyChain(
              options.pool,
              { url: `${scheme}://${a.discovery.vendor.host}/` },
              {
                identity,
                ...(a.discovery.vendor.name ? { vendorName: a.discovery.vendor.name } : {}),
                limits: options.subProcessors,
                now,
              },
            ),
          );
        } catch (e) {
          await report({
            stage: 'walking sub-processors',
            detail: (e as Error).message.slice(0, 300),
          });
        }
      }
    }

    // 3. The record: contract findings reconciled, the chains written to the graph.
    const drafts = results.flatMap((a) => {
      const d = agreementDraft(a, domain);
      return d ? [d] : [];
    });
    const assembled = assembleFindings(
      { drafts },
      {
        tenantId,
        caseId,
        jurisdiction: c.jurisdiction as 'DK' | 'DE',
        catalogue: options.catalogue,
        host: domain,
        scanId: job.id,
        now,
      },
    );
    const evidence = [
      ...results.flatMap((a) => a.evidence),
      ...chains.flatMap((ch) => ch.evidence),
    ];
    const raised: Finding[] = [...assembled.findings];
    await recordScan(connection, tenantId, caseId, {
      scanId: job.id,
      kind: 'deep',
      findings: raised,
      evidence: evidence.map((e) => ({ ...e, tenantId, caseId })),
      checksRun: results.length,
      checksPassed: results.filter((a) => a.discovery.outcome === 'found').length,
      undetermined: results.filter((a) => a.discovery.outcome === 'unreachable').length,
      actor: job.payload.requestedBy,
      now: now(),
      scope: new Set(Object.values(AGREEMENT_FINDINGS)),
    });
    for (const ch of chains) {
      await seedSupplyChain(connection, tenantId, caseId, {
        chain: ch.chain,
        scanId: job.id,
        now: now(),
        resolve: (h) => resolveHost(h),
      });
    }
    await report({
      stage: 'done',
      outcome: 'done',
      suppliers: results.length,
      findings: raised.length,
      plan: outcome.rationales.map((r) => ({ type: r.type, rationale: r.rationale.slice(0, 300) })),
      source: outcome.source,
    });
  });
}
