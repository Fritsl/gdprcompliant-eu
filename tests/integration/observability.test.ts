import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModelClient, verifyClaim } from '@gc/agent';
import { loadConfig, type FetchLike } from '@gc/config';
import { ClaimSchema } from '@gc/contracts';
import {
  SCAN_JOB,
  SCAN_STAGES,
  STAGE_MARKS,
  createTestDatabase,
  seedRemedies,
  testDatabaseUrl,
  type TestDatabase,
} from '@gc/db';
import { JobQueue } from '@gc/jobs';
import { loadCatalogue } from '@gc/remedies';
import { BrowserPool, FixtureServer, loadFixtureSites } from '@gc/scanner';
import {
  JsonLinesSink,
  MemorySink,
  REDACTED,
  event,
  metrics,
  setSink,
  verifierRejectionRate,
} from '@gc/telemetry';
import { registerScanWorker } from '@gc/worker';

// Observability (O-04): a scan of the fixture estate, run through the queue and the
// worker, reads back end to end from its trace; model latency and tokens are tracked
// per call; every verifier verdict is counted so the gate has a rate; and nothing
// personal reaches a log line, which a scan of every line produced asserts.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const url = testDatabaseUrl();
const endpoints = JSON.parse(
  readFileSync(join(ROOT, 'packages', 'config', 'endpoints.json'), 'utf8'),
) as { host: string; purpose: string; jurisdiction: string }[];
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
  { endpoints: [...endpoints, { host: 'llm.example.eu', purpose: 'model', jurisdiction: 'DK' }] },
);
const T0 = new Date('2026-09-04T11:00:00Z');

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const CPR = /\b\d{6}-?\d{4}\b/;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const BEARER = /bearer\s+[A-Za-z0-9._-]{4,}/i;

describe.skipIf(!url)('observability (O-04)', () => {
  const sink = new MemorySink();
  let t: TestDatabase;
  let fixtures: FixtureServer;
  let pool: BrowserPool;
  let queue: JobQueue;
  let jobId = '';

  beforeAll(async () => {
    setSink(sink);
    metrics.reset();
    t = await createTestDatabase(url);
    const catalogue = loadCatalogue();
    await seedRemedies(t, catalogue);
    fixtures = await new FixtureServer(loadFixtureSites().flatMap((s) => s.hosts)).start();
    pool = await new BrowserPool({
      concurrency: 2,
      passTimeoutMs: 60_000,
      navigationTimeoutMs: 10_000,
      launch: { proxy: { server: fixtures.proxy } },
      ignoreHTTPSErrors: true,
    }).start();
    queue = new JobQueue({ connectionString: url, pollingIntervalSeconds: 1 });
    await queue.start();
    await registerScanWorker(queue, t, {
      pool,
      catalogue,
      quiet: { minDwellMs: 800, quietMs: 400, maxWaitMs: 8_000 },
    });
    jobId = await queue.enqueue(SCAN_JOB, {
      domain: 'usikker.test',
      locale: 'da',
      source: 'internal',
    });
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const s = await queue.status(SCAN_JOB, jobId);
      if (s && ['completed', 'failed', 'cancelled'].includes(s.state)) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('the scan did not finish');
  }, 300_000);

  afterAll(async () => {
    setSink(new JsonLinesSink(() => undefined));
    await queue?.stop({ graceful: false });
    await pool?.stop();
    await fixtures?.stop();
    await t?.drop();
  });

  it('a scan reads back end to end from its trace: the job, the scan, every stage in order', () => {
    const trace = sink.byTrace(jobId);
    expect(trace.length).toBeGreaterThan(SCAN_STAGES.length);
    const run = trace.find((r) => r.kind === 'span' && r.name === 'job.run');
    expect(run?.fields).toMatchObject({ job: 'scan-site', jobId, outcome: 'ok' });
    expect(run?.durationMs).toBeGreaterThan(0);
    const scan = trace.find((r) => r.kind === 'span' && r.name === 'scan.job');
    expect(scan?.fields).toMatchObject({ domain: 'usikker.test', outcome: 'ok' });
    const stages = trace.filter((r) => r.name === 'scan.stage');
    expect(stages[0]?.fields['stage']).toBe('opening');
    for (const stage of SCAN_STAGES)
      expect(
        stages.map((s) => s.fields['stage']),
        stage,
      ).toContain(stage);
    for (const s of stages) expect(STAGE_MARKS).toContain(s.fields['mark']);
    expect(stages.filter((s) => s.fields['stage'] === 'writing-up').at(-1)?.fields['mark']).toBe(
      'ok',
    );
    // In order, on the clock.
    const ats = trace.map((r) => r.at);
    expect([...ats].sort()).toEqual(ats);
    // The spans close after the stages they cover.
    expect(scan!.at >= stages.at(-1)!.at).toBe(true);
  });

  it('model latency and tokens are tracked per call, whether the answer was usable or not', async () => {
    const before = metrics.count('model.calls', { call: 'answer_question', ok: true });
    const stub: FetchLike = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'not the json the schema asks for' } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const client = new ModelClient(config, { fetch: stub });
    await expect(
      client.call({ name: 'answer_question', input: { question: 'What is this?', locale: 'en' } }),
    ).rejects.toThrow();
    const attempts = metrics.count('model.calls', { call: 'answer_question', ok: true }) - before;
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(metrics.count('model.tokens', { call: 'answer_question', kind: 'prompt' })).toBe(
      12 * attempts,
    );
    expect(metrics.count('model.tokens', { call: 'answer_question', kind: 'completion' })).toBe(
      3 * attempts,
    );
    const latency = metrics.snapshot().histograms['model.latency_ms|call=answer_question'];
    expect(latency?.count).toBe(attempts);
    expect(latency?.min).toBeGreaterThanOrEqual(0);
    const calls = sink.named('model.call').filter((r) => r.fields['call'] === 'answer_question');
    expect(calls.length).toBe(attempts);
    expect(calls[0]?.fields).toMatchObject({ status: 200, promptTokens: 12, completionTokens: 3 });
    expect(typeof calls[0]?.fields['latencyMs']).toBe('number');
    // A transport failure is a call too, counted as not ok.
    const down: FetchLike = async () => {
      throw new Error('connection refused');
    };
    await expect(
      new ModelClient(config, { fetch: down }).call({
        name: 'answer_question',
        input: { question: 'Still there?', locale: 'en' },
      }),
    ).rejects.toThrow();
    expect(
      metrics.count('model.calls', { call: 'answer_question', ok: false }),
    ).toBeGreaterThanOrEqual(1);
    expect(sink.named('model.call').some((r) => r.fields['status'] === 'transport')).toBe(true);
  });

  it('every verifier verdict is counted, so the gate has a rate to watch', async () => {
    const claim = ClaimSchema.parse({
      id: 'claim:obs:1',
      caseId: 'DK-26-OBS1',
      kind: 'observation',
      statement: 'The site sets a cookie before consent.',
      evidence: [{ evidenceId: 'cookie:0000000000000000', hash: 'a'.repeat(64) }],
      producedBy: { worker: 'test' },
      at: T0.toISOString(),
    });
    const verdict = await verifyClaim(claim, {
      evidence: async () => undefined,
      resolve: async () => ({ ok: false, reason: 'not asked' }) as never,
      now: () => T0,
    });
    expect(verdict.verdict).toBe('rejected');
    const rate = verifierRejectionRate();
    expect(rate).toEqual({ claims: 1, rejected: 1, rate: 1 });
    const recorded = sink.named('verifier.verdict');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.fields).toMatchObject({ claimId: 'claim:obs:1', verdict: 'rejected' });
    expect(String(recorded[0]?.fields['reason'])).toContain('not stored');
  });

  it('nothing personal reaches a line: a planted record is redacted, and the scan wrote none', () => {
    event('test.planted', {
      email: 'mette@eksempelbutik.dk',
      name: 'Mette Sørensen',
      note: 'ring +45 12 34 56 78, cpr 010190-1234, from 10.0.0.1, auth Bearer abc.def.ghi',
      url: 'https://eksempelbutik.dk/p?token=secret',
      body: '<html>the whole page</html>',
      nested: { contact: 'lars@eksempelbutik.dk' },
    });
    const planted = sink.named('test.planted')[0]!;
    expect(planted.fields).toMatchObject({
      email: REDACTED,
      name: REDACTED,
      body: REDACTED,
      url: `https://eksempelbutik.dk/p?${REDACTED}`,
      nested: { contact: REDACTED },
    });
    const note = String(planted.fields['note']);
    expect(note).not.toMatch(/12 34 56 78|010190|10\.0\.0\.1|abc\.def/);
    expect(note.split(REDACTED).length - 1).toBeGreaterThanOrEqual(4);
    // Every line the scan produced, scanned.
    for (const r of sink.records) {
      const line = JSON.stringify(r);
      expect(line, r.name).not.toMatch(EMAIL);
      expect(line, r.name).not.toMatch(CPR);
      expect(line, r.name).not.toMatch(IPV4);
      expect(line, r.name).not.toMatch(BEARER);
      expect(line, r.name).not.toMatch(/"(body|text|html|raw|quote)":"(?!\[redacted\])/);
      expect(line, r.name).not.toMatch(/Mette|Sofie|Sørensen/);
    }
    expect(sink.records.length).toBeGreaterThan(10);
  });
});
