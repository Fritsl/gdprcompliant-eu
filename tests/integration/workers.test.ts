import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Dispatcher,
  ModelClient,
  TASK_CATALOGUE,
  createClaimVerifier,
  createContractReader,
  createCrawler,
  createDrafter,
  createRegistryAdapter,
  createResearcher,
  createWorkers,
  type Collected,
} from '@gc/agent';
import { loadConfig } from '@gc/config';
import { ClaimSchema, TaskResultSchema, sha256, type Claim, type PlannerTask } from '@gc/contracts';
import {
  deterministicEmbedder,
  ingestCorpus,
  loadCorpusDocuments,
  resolveCitation,
  retrieve,
} from '@gc/corpus';
import {
  createTestDatabase,
  openCase,
  schema,
  storeEvidence,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { bannedClaims, loadClaimVocabulary } from '@gc/i18n';
import {
  BrowserPool,
  FixtureServer,
  captureToEvidence,
  collectPassA,
  collectPassB,
  loadFixtureSites,
} from '@gc/scanner';
import { eq } from 'drizzle-orm';

// The workers (A-05): one narrow specialist per task type, each built from the tools
// it is given and nothing else. The crawler reads the estate through the scanner and
// knows no corpus; the contract reader reads stored evidence and calls only the model;
// the registry adapter asks a register it is handed; the researcher asks the corpus;
// the drafter asks the generator; the verifier gates the claims. Every one returns
// claims that point at evidence, never a finding and never a verdict of its own.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const T0 = new Date('2026-09-04T09:14:00Z');
const NOW = () => T0;
const vocab = loadClaimVocabulary();
const sites = loadFixtureSites();
const config = loadConfig(
  {
    NODE_ENV: 'test',
    APP_BASE_URL: 'https://gdprcompliant.eu',
    DATABASE_URL: 'postgres://gc:gc@localhost:5432/gc',
    MODEL_BASE_URL: 'https://llm.example.eu/v1',
    MODEL_API_KEY: 'sk-test',
    MODEL_CHAT: 'chat-model',
    MODEL_EMBEDDING: 'embed-model',
  },
  { endpoints: [{ host: 'llm.example.eu', purpose: 'model', jurisdiction: 'DK' }] },
);

// A model that answers from the question, as JSON the client accepts.
function answeringModel(answer: (question: string) => string) {
  const impl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { content: string }[] };
    const user = body.messages?.at(-1)?.content ?? '';
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({ answer: answer(user), grounded: [], followups: [] }),
            },
            finish_reason: 'stop',
          },
        ],
      }),
      { status: 200 },
    );
  });
  return { client: new ModelClient(config, { fetch: impl }), impl };
}

const task = <T extends PlannerTask['type']>(
  type: T,
  id: string,
  caseId: string,
  payload: Extract<PlannerTask, { type: T }>['payload'],
): Extract<PlannerTask, { type: T }> =>
  ({
    id,
    caseId,
    type,
    payload,
    cost: TASK_CATALOGUE[type].cost(payload as never),
    dependsOn: [],
    status: 'pending',
    attempts: 0,
    createdAt: T0.toISOString(),
  }) as Extract<PlannerTask, { type: T }>;

const workersDir = join(ROOT, 'packages', 'agent', 'src', 'workers');
const source = (file: string) => readFileSync(join(workersDir, file), 'utf8');

describe.skipIf(!url)('the workers (A-05)', () => {
  let t: TestDatabase;
  let tenantId = '';
  let caseId = '';
  let server: FixtureServer;
  let pool: BrowserPool;
  const claims: Claim[] = [];
  const identity = () => ({ tenantId, caseId });

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const opened = await openCase(t, {
      company: { domain: 'tags.shop.test', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: NOW,
    });
    tenantId = opened.tenantId;
    caseId = opened.caseId;
    const gdpr = loadCorpusDocuments().find((d) => d.instrument === 'GDPR')!;
    await ingestCorpus(t, gdpr, deterministicEmbedder());
    server = await new FixtureServer(sites.flatMap((s) => s.hosts)).start();
    pool = await new BrowserPool({
      concurrency: 2,
      passTimeoutMs: 60_000,
      navigationTimeoutMs: 15_000,
      launch: { proxy: { server: server.proxy } },
      ignoreHTTPSErrors: true,
      resolveEgress: false,
    }).start();
  }, 300_000);

  afterAll(async () => {
    await pool?.stop();
    await server?.stop();
    await t?.drop();
  });

  // The scanner, narrowed to what the crawler is allowed: passes against one address.
  const collect: Parameters<typeof createCrawler>[0]['collect'] = async (site, passes, id) => {
    const quiet = { minDwellMs: 1_500, quietMs: 500, maxWaitMs: 8_000 };
    const out: Collected[] = [];
    for (const pass of passes) {
      if (pass === 'A') {
        const a = await collectPassA(pool, { url: site }, { quiet });
        out.push({ pass, evidence: captureToEvidence(a.capture, a.screenshot, id) });
      } else if (pass === 'B') {
        const b = await collectPassB(pool, { url: site }, { identity: id, quiet, now: NOW });
        out.push({
          pass,
          evidence: [...captureToEvidence(b.capture, b.screenshot, id), ...b.evidence],
        });
      }
    }
    return out;
  };

  it('every worker file imports only what its job needs: no corpus in the crawler, no network in the reader', () => {
    const files = readdirSync(workersDir).filter((f) => f.endsWith('.ts'));
    expect(files.sort()).toEqual(
      [
        'claim-verifier.ts',
        'contract-reader.ts',
        'crawler.ts',
        'drafter.ts',
        'index.ts',
        'registry-adapter.ts',
        'researcher.ts',
        'shared.ts',
      ].sort(),
    );
    for (const f of files) {
      const s = source(f);
      // No worker reaches for a browser, a socket, a database or a register on its own.
      expect(s, f).not.toMatch(
        /@gc\/scanner|@gc\/db|@gc\/corpus|playwright|node:http|node:net|\bfetch\(/,
      );
    }
    expect(source('crawler.ts')).not.toMatch(/corpus|citation|retrieve/i);
    expect(source('contract-reader.ts')).not.toMatch(/collect|crawl|scanner|\bfetch\(/i);
    // The catalogue agrees: readers have no network.
    expect(TASK_CATALOGUE.read_contract.network).toBe(false);
    expect(TASK_CATALOGUE.research.network).toBe(false);
    expect(TASK_CATALOGUE.crawl.network).toBe(true);
  });

  it('the crawler returns the passes as evidence and observation claims on them, nothing more', async () => {
    const crawler = createCrawler({ ...identity(), collect, now: NOW });
    const out = await crawler(
      task('crawl', 'task-crawl', caseId, {
        url: 'https://tags.shop.test/',
        depth: 0,
        passes: ['A'],
      }),
    );
    expect(TaskResultSchema.safeParse(out.result).success).toBe(true);
    expect(TASK_CATALOGUE.crawl.output.safeParse(out.output).success).toBe(true);
    const passes = (out.output as { passes: { pass: string; evidenceIds: string[] }[] }).passes;
    expect(passes).toHaveLength(1);
    expect(passes[0]!.pass).toBe('A');
    expect(passes[0]!.evidenceIds.length).toBeGreaterThan(2);
    expect(out.result.evidence.map((e) => e.id)).toEqual(passes[0]!.evidenceIds);
    expect(out.result.claims).toHaveLength(1);
    expect(out.result.claims[0]).toMatchObject({
      kind: 'observation',
      producedBy: { worker: 'crawler', taskId: 'task-crawl' },
    });
    expect(out.result.claims[0]!.evidence.length).toBeGreaterThan(0);
    await storeEvidence(t, tenantId, out.result.evidence);
    claims.push(...out.result.claims);
  });

  it('the contract reader answers from stored evidence through the model alone, and makes no other call', async () => {
    const text =
      'Databehandleraftale. Databehandleren er Eksempel Hosting ApS, CVR 12345678. Personoplysninger opbevares i EU.';
    const hash = sha256(text);
    const docId = `document:${hash.slice(0, 16)}`;
    await storeEvidence(t, tenantId, [
      {
        id: docId,
        tenantId,
        caseId,
        kind: 'document',
        capturedAt: T0.toISOString(),
        source: { url: 'https://tags.shop.test/dpa.pdf', host: 'tags.shop.test' },
        body: text,
        hash,
        caption: 'processing agreement',
      },
    ]);
    const { client, impl } = answeringModel((q) =>
      q.includes('processor')
        ? 'Eksempel Hosting ApS, CVR 12345678.'
        : 'The document does not say.',
    );
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const reader = createContractReader({
      ...identity(),
      model: client,
      evidenceById: (id) =>
        withTenant(t, tenantId, async (db) => {
          const [row] = await db.select().from(schema.evidence).where(eq(schema.evidence.id, id));
          return row
            ? {
                ...row,
                capturedAt: row.capturedAt.toISOString(),
                source: row.observed as { url: string; host: string },
                scanId: row.scanId ?? undefined,
                caption: row.caption ?? undefined,
              }
            : undefined;
        }),
      now: NOW,
    });
    const out = await reader(
      task('read_contract', 'task-read', caseId, {
        documentEvidenceId: docId,
        questions: ['Who is the processor?', 'What is the retention period?'],
      }),
    );
    expect(TASK_CATALOGUE.read_contract.output.safeParse(out.output).success).toBe(true);
    const answers = (
      out.output as {
        answers: { question: string; answer: string; evidence: { evidenceId: string } }[];
      }
    ).answers;
    expect(answers.map((a) => a.answer)).toEqual([
      'Eksempel Hosting ApS, CVR 12345678.',
      'The document does not say.',
    ]);
    expect(answers.every((a) => a.evidence.evidenceId === docId)).toBe(true);
    expect(out.result.claims).toHaveLength(2);
    expect(
      out.result.claims.every(
        (c) => c.kind === 'observation' && c.evidence[0]!.evidenceId === docId,
      ),
    ).toBe(true);
    // Two model calls, to the model endpoint, and nothing through the global fetch.
    expect(impl).toHaveBeenCalledTimes(2);
    for (const call of impl.mock.calls) expect(String(call[0])).toContain('llm.example.eu');
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
    // The document reached the model fenced as untrusted, after the instructions.
    const body = JSON.parse(String(impl.mock.calls[0]![1]?.body ?? '{}')) as {
      messages: { content: string }[];
    };
    const prompt = body.messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('Eksempel Hosting ApS');
    expect(prompt.indexOf('read one contract')).toBeLessThan(
      prompt.indexOf('Eksempel Hosting ApS'),
    );
    claims.push(...out.result.claims);
    // A document the store does not hold is a final failure, not a guess.
    const missing = await reader(
      task('read_contract', 'task-read-2', caseId, {
        documentEvidenceId: 'document:0000000000000000',
        questions: ['Who?'],
      }),
    );
    expect(missing.result.failure).toMatchObject({ retryable: false });
  });

  it('the registry adapter records what the register answered, as evidence', async () => {
    const adapter = createRegistryAdapter({
      ...identity(),
      lookup: async (registry, query) =>
        registry === 'cvr' && query.domain === 'tags.shop.test'
          ? [
              {
                registryId: '12345678',
                name: 'Tags Shop ApS',
                record: {
                  cvr: '12345678',
                  name: 'Tags Shop ApS',
                  address: 'Kaffevej 2, 8000 Aarhus C',
                },
                source: { url: 'https://cvr.dk/', host: 'cvr.dk', fetchedAt: T0.toISOString() },
              },
            ]
          : [],
      now: NOW,
    });
    const out = await adapter(
      task('registry_lookup', 'task-reg', caseId, {
        registry: 'cvr',
        query: { domain: 'tags.shop.test' },
      }),
    );
    expect(TASK_CATALOGUE.registry_lookup.output.safeParse(out.output).success).toBe(true);
    expect(out.result.evidence).toHaveLength(1);
    expect(out.result.evidence[0]).toMatchObject({
      kind: 'registry_record',
      caption: 'cvr: Tags Shop ApS (12345678)',
    });
    expect(out.result.claims[0]!.statement).toBe('cvr lists Tags Shop ApS under 12345678.');
    await storeEvidence(t, tenantId, out.result.evidence);
    claims.push(...out.result.claims);
    const none = await adapter(
      task('registry_lookup', 'task-reg-2', caseId, { registry: 'cvr', query: { name: 'Nobody' } }),
    );
    expect((none.output as { matches: unknown[] }).matches).toEqual([]);
    expect(none.result.claims).toEqual([]);
  });

  it('the researcher returns passages with citations that resolve, in the case’s jurisdiction', async () => {
    const embedder = deterministicEmbedder();
    const researcher = createResearcher({
      ...identity(),
      retrieve: (question, jurisdiction, k) => retrieve(t, question, embedder, { jurisdiction, k }),
      now: NOW,
    });
    const out = await researcher(
      task('research', 'task-research', caseId, {
        question: 'Withdrawal of consent must be as easy as giving it',
        jurisdiction: 'DK',
        maxPassages: 3,
      }),
    );
    expect(TASK_CATALOGUE.research.output.safeParse(out.output).success).toBe(true);
    const passages = (
      out.output as {
        passages: { citation: { kind: string; ref: string }; evidence: { evidenceId: string } }[];
      }
    ).passages;
    expect(passages).toHaveLength(3);
    for (const p of passages) {
      expect(p.citation.kind).toBe('provision');
      const resolved = await resolveCitation(t, p.citation as never, 'DK');
      expect(resolved.ok, p.citation.ref).toBe(true);
    }
    expect(out.result.evidence).toHaveLength(3);
    expect(
      out.result.claims.every(
        (c) => c.kind === 'observation' && c.citations.length === 1 && c.corpusVersion,
      ),
    ).toBe(true);
    await storeEvidence(t, tenantId, out.result.evidence);
    claims.push(...out.result.claims);
  });

  it('the drafter hands the draft on, and refuses when the generator names gaps', async () => {
    const evidenceRef = {
      evidenceId: claims[0]!.evidence[0]!.evidenceId,
      hash: claims[0]!.evidence[0]!.hash,
    };
    const drafter = createDrafter({
      ...identity(),
      generate: async (kind, locale, inputs) =>
        inputs.evidence.length > 0
          ? { ok: true, artefact: { artefactId: `artefact:${caseId}:${kind}`, kind, version: 1 } }
          : { ok: false, gaps: [{ text: `no evidence for a ${kind} in ${locale}` }] },
      now: NOW,
    });
    const written = await drafter(
      task('draft', 'task-draft', caseId, {
        artefact: 'privacy_policy',
        locale: 'da',
        inputs: { evidence: [evidenceRef], questionIds: [] },
      }),
    );
    expect(TASK_CATALOGUE.draft.output.safeParse(written.output).success).toBe(true);
    expect(written.result.claims).toHaveLength(1);
    expect(written.result.claims[0]).toMatchObject({ kind: 'drafting', evidence: [evidenceRef] });
    const refused = await drafter(
      task('draft', 'task-draft-2', caseId, {
        artefact: 'privacy_policy',
        locale: 'da',
        inputs: { evidence: [], questionIds: [] },
      }),
    );
    expect(refused.result.failure).toMatchObject({ retryable: false });
    expect(refused.result.failure!.reason).toContain('no evidence for a privacy_policy in da');
    claims.push(...written.result.claims);
  });

  it('the verifier accepts claims whose evidence exists and rejects the rest, and a claim it was not given', async () => {
    const verifier = createClaimVerifier({
      ...identity(),
      claimsById: async (ids) => claims.filter((c) => ids.includes(c.id)),
      verifier: {
        evidence: (_claim, ref) =>
          withTenant(t, tenantId, async (db) => {
            const [row] = await db
              .select()
              .from(schema.evidence)
              .where(eq(schema.evidence.id, ref.evidenceId));
            return row
              ? {
                  ...row,
                  capturedAt: row.capturedAt.toISOString(),
                  source: row.observed as { url: string; host: string },
                  scanId: row.scanId ?? undefined,
                  caption: row.caption ?? undefined,
                }
              : undefined;
          }),
        resolve: (citation, jurisdiction, corpusVersion) =>
          resolveCitation(t, citation, jurisdiction, corpusVersion ? { corpusVersion } : {}),
        now: NOW,
      },
    });
    const bogus = ClaimSchema.parse({
      ...claims[0]!,
      id: 'claim:bogus',
      evidence: [{ evidenceId: 'text:ffffffffffffffff', hash: sha256('nothing') }],
    });
    claims.push(bogus);
    const out = await verifier(
      task('verify_claims', 'task-verify', caseId, {
        claimIds: [...claims.map((c) => c.id), 'claim:never-offered'],
      }),
    );
    expect(TASK_CATALOGUE.verify_claims.output.safeParse(out.output).success).toBe(true);
    const verdicts = (
      out.output as { verdicts: { claimId: string; verdict: string; reason?: string }[] }
    ).verdicts;
    const by = (id: string) => verdicts.find((v) => v.claimId === id)!;
    for (const c of claims.filter((c) => c.id !== 'claim:bogus'))
      expect(by(c.id).verdict, c.statement).toBe('accepted');
    expect(by('claim:bogus').verdict).toBe('rejected');
    expect(by('claim:never-offered')).toMatchObject({
      verdict: 'rejected',
      reason: 'no claim claim:never-offered was offered',
    });
  });

  it('every claim any worker made points at evidence and states what was seen, never a verdict', () => {
    expect(claims.length).toBeGreaterThan(6);
    for (const c of claims) {
      expect(ClaimSchema.safeParse(c).success).toBe(true);
      expect(['observation', 'drafting']).toContain(c.kind);
      expect(c.evidence.length).toBeGreaterThan(0);
      expect(bannedClaims(c.statement, 'en', vocab), c.statement).toEqual([]);
      expect(c.statement).not.toMatch(/\b(finding|must fix|should fix|in breach)\b/i);
    }
  });

  it('the dispatcher runs the workers as one plan, in dependency order, within budget', async () => {
    const { client } = answeringModel(() => 'The document does not say.');
    const workers = createWorkers({
      crawler: { ...identity(), collect, now: NOW },
      contractReader: {
        ...identity(),
        model: client,
        evidenceById: async () => undefined,
        now: NOW,
      },
      registryAdapter: { ...identity(), lookup: async () => [], now: NOW },
    });
    let n = 0;
    const d = new Dispatcher({
      budgets: { perCase: 500, perScan: 200 },
      workers,
      now: NOW,
      newId: () => `plan-${++n}`,
    });
    const plan = d.plan(caseId, [
      {
        proposal: {
          type: 'crawl',
          payload: { url: 'https://tags.shop.test/', depth: 0, passes: ['A'] },
          rationale: 'first load',
        },
      },
      {
        proposal: {
          type: 'registry_lookup',
          payload: { registry: 'cvr', query: { domain: 'tags.shop.test' } },
          rationale: 'who owns it',
        },
      },
      {
        proposal: {
          type: 'read_contract',
          payload: { documentEvidenceId: 'document:0000000000000000', questions: ['Who?'] },
          rationale: 'the dpa',
        },
        dependsOn: [0],
      },
      {
        proposal: {
          type: 'research',
          payload: { question: 'x', jurisdiction: 'DK', maxPassages: 1 },
          rationale: 'law',
        },
      },
    ]);
    const report = await d.run(plan, 'scan-workers');
    expect(report.tasks.map((x) => [x.type, x.status])).toEqual([
      ['crawl', 'done'],
      ['registry_lookup', 'done'],
      ['read_contract', 'failed'],
      ['research', 'skipped'],
    ]);
    expect(report.tasks[2]!.reason).toContain('final: no stored document');
    expect(report.tasks[3]!.reason).toBe('no worker for research');
    expect(report.tasks[0]!.result!.claims.length).toBe(1);
  });
});
