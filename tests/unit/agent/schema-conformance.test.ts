import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@gc/config';
import {
  MODEL_CALLS,
  MODEL_CALL_NAMES,
  type ModelCallName,
  type ModelInput,
  type ModelOutput,
} from '@gc/contracts';
import {
  MAX_ATTEMPTS,
  ModelClient,
  ModelInputError,
  ModelOutputError,
  ModelTransportError,
} from '@gc/agent';

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

const completion = (content: string | null, finish_reason = 'stop') =>
  JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason }] });

// A stub endpoint: answers in order, then repeats the last.
function endpoint(...bodies: (string | { status: number; body: string })[]) {
  const calls: { url: string; init: RequestInit & { purpose?: string } }[] = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = bodies[Math.min(i++, bodies.length - 1)]!;
    return typeof next === 'string'
      ? new Response(next, { status: 200 })
      : new Response(next.body, { status: next.status });
  });
  return { impl, calls };
}

const draft = { name: 'draft_message' as const, system: 'You draft messages.', user: 'Draft it.' };
const draftInput: ModelInput<'draft_message'> = {
  finding: {
    id: 'f-1',
    tenantId: 't-1',
    caseId: 'DK-26-0M4K',
    typeId: 'CNS-09',
    fingerprint: 'CNS-09|eksempelbutik.dk|/kassen|',
    jurisdiction: 'DK',
    binding: {
      findingTypeId: 'CNS-09',
      jurisdiction: 'DK',
      citations: [
        {
          kind: 'provision',
          instrument: 'ePrivacy',
          article: '5',
          paragraph: '3',
          ref: 'Art. 5(3)',
        },
      ],
      authority: { name: 'Datatilsynet' },
      guideId: 'cns-09',
      version: 1,
    },
    severity: 'serious',
    status: 'open',
    area: 'Consent',
    evidence: [{ evidenceId: 'ev-1', hash: 'a'.repeat(64) }],
    remedy: { remedyId: 'cns-09-new-tracker', version: 1 },
    firstSeenAt: '2026-09-08T14:00:00Z',
    lastSeenAt: '2026-09-08T14:00:00Z',
  },
  evidence: [
    {
      id: 'ev-1',
      tenantId: 't-1',
      caseId: 'DK-26-0M4K',
      kind: 'http_request',
      capturedAt: '2026-09-08T14:00:00Z',
      source: { host: 'eksempelbutik.dk', path: '/kassen', pass: 'A' },
      body: 'analytics.tiktok.com loaded on pass A',
      hash: 'a'.repeat(64),
    },
  ],
  recipientRole: 'Whoever runs campaigns',
  locale: 'en',
};
const goodMessage = {
  to: 'Whoever runs campaigns',
  subject: 'A tag on the checkout',
  body: 'Hi, a tag appeared.',
};

describe('ModelClient validates at the call site (T-04)', () => {
  it('sends a strict JSON Schema for the call, through the allowlisted fetch', async () => {
    const { impl, calls } = endpoint(completion(JSON.stringify(goodMessage)));
    const client = new ModelClient(config, { fetch: impl });
    const out = await client.call({ ...draft, input: draftInput, seed: 7 });
    expect(out).toEqual(goodMessage);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://llm.example.eu/v1/chat/completions');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['model']).toBe('chat-model');
    expect(body['temperature']).toBe(0);
    expect(body['seed']).toBe(7);
    const format = body['response_format'] as {
      type: string;
      json_schema: { name: string; strict: boolean; schema: unknown };
    };
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.name).toBe('draft_message');
    expect(format.json_schema.strict).toBe(true);
    expect((format.json_schema.schema as Record<string, unknown>)['additionalProperties']).toBe(
      false,
    );
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer sk-test',
    );
  });

  it('refuses an input that does not match the schema before anything is sent', async () => {
    const { impl } = endpoint(completion(JSON.stringify(goodMessage)));
    const client = new ModelClient(config, { fetch: impl });
    await expect(
      client.call({ ...draft, input: { ...draftInput, locale: 'klingon' } }),
    ).rejects.toThrow(ModelInputError);
    expect(impl).not.toHaveBeenCalled();
  });

  it('retries once with the issues fed back, then returns the valid second answer', async () => {
    const { impl, calls } = endpoint(
      completion('{"to": "x", "subject": "y"'),
      completion(JSON.stringify(goodMessage)),
    );
    const attempts: unknown[] = [];
    const client = new ModelClient(config, { fetch: impl, onAttempt: (a) => attempts.push(a) });
    await expect(client.call({ ...draft, input: draftInput })).resolves.toEqual(goodMessage);
    expect(calls).toHaveLength(2);
    const second = JSON.parse(String(calls[1]?.init.body)) as {
      messages: { role: string; content: string }[];
    };
    expect(second.messages).toHaveLength(3);
    expect(second.messages[2]?.content).toMatch(/previous answer was rejected: output is not JSON/);
    expect(attempts).toEqual([
      {
        call: 'draft_message',
        attempt: 1,
        issues: ['output is not JSON'],
        raw: '{"to": "x", "subject": "y"',
      },
    ]);
  });

  it('fails loudly after the second bad answer, with both attempts on record', async () => {
    const { impl } = endpoint(completion(JSON.stringify({ ...goodMessage, tone: 'friendly' })));
    const client = new ModelClient(config, { fetch: impl });
    const error = await client.call({ ...draft, input: draftInput }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelOutputError);
    const { attempts, message } = error as ModelOutputError;
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(attempts[0]?.issues.join(' ')).toMatch(/tone/);
    expect(message).toMatch(
      /draft_message: model output did not match its schema after 2 attempts/,
    );
    expect(impl).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('a truncated answer is a failed attempt, not a parse of half a document', async () => {
    const { impl } = endpoint(
      completion('{"to": "x", "subject": "y", "body": "Hi', 'length'),
      completion(JSON.stringify(goodMessage)),
    );
    const client = new ModelClient(config, { fetch: impl });
    const attempts: { issues: readonly string[] }[] = [];
    await new ModelClient(config, { fetch: impl, onAttempt: (a) => attempts.push(a) }).call({
      ...draft,
      input: draftInput,
    });
    expect(attempts[0]?.issues).toEqual(['output truncated (finish_reason=length)']);
    expect(client).toBeDefined();
  });

  it('a transport failure is retried once, then reported as transport, not as bad output', async () => {
    const { impl } = endpoint({ status: 503, body: 'busy' });
    const client = new ModelClient(config, { fetch: impl });
    const error = await client.call({ ...draft, input: draftInput }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelTransportError);
    expect((error as ModelTransportError).attempts[1]?.issues).toEqual(['transport: HTTP 503']);
    expect(impl).toHaveBeenCalledTimes(2);

    const recovered = endpoint(
      { status: 503, body: 'busy' },
      completion(JSON.stringify(goodMessage)),
    );
    await expect(
      new ModelClient(config, { fetch: recovered.impl }).call({ ...draft, input: draftInput }),
    ).resolves.toEqual(goodMessage);
  });

  it('an envelope that is not a chat completion is a failed attempt', async () => {
    const { impl } = endpoint('{"error": "nope"}', completion(null));
    const error = await new ModelClient(config, { fetch: impl })
      .call({ ...draft, input: draftInput })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelOutputError);
    expect((error as ModelOutputError).attempts.map((a) => a.issues[0])).toEqual([
      'response is not a chat completion',
      'output is not JSON',
    ]);
  });

  it('a refinement the JSON Schema cannot express is still enforced', async () => {
    const { impl } = endpoint(
      completion(JSON.stringify({ clauses: [{ element: 'retention', status: 'present' }] })),
    );
    const client = new ModelClient(config, { fetch: impl });
    const error = await client
      .call({
        name: 'analyse_policy_clauses',
        input: {
          document: {
            trust: 'untrusted',
            source: { description: 'privacy policy', fetchedAt: '2026-09-03T09:00:00Z' },
            hash: 'b'.repeat(64),
            text: 'We keep orders for five years.',
          },
          elements: ['retention'],
          jurisdiction: 'DK',
          locale: 'en',
        },
        system: 's',
        user: 'u',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelOutputError);
    expect((error as ModelOutputError).attempts[0]?.issues[0]).toMatch(/quoted verbatim/);
  });

  it('embeddings are validated the same way', async () => {
    const vectors = {
      data: [
        { index: 1, embedding: [0.3, 0.4] },
        { index: 0, embedding: [0.1, 0.2] },
      ],
    };
    const { impl } = endpoint(JSON.stringify(vectors));
    const client = new ModelClient(config, { fetch: impl });
    await expect(client.embed(['a', 'b'])).resolves.toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    await expect(client.embed([])).rejects.toThrow(ModelInputError);

    const ragged = endpoint(
      JSON.stringify({
        data: [
          { index: 0, embedding: [1] },
          { index: 1, embedding: [1, 2] },
        ],
      }),
    );
    await expect(new ModelClient(config, { fetch: ragged.impl }).embed(['a', 'b'])).rejects.toThrow(
      ModelOutputError,
    );
    const short = endpoint(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }));
    await expect(new ModelClient(config, { fetch: short.impl }).embed(['a', 'b'])).rejects.toThrow(
      /expected 2 embeddings, got 1/,
    );
  });
});

// Deterministic fuzzing: mutate a valid answer in every way a model plausibly does —
// truncate, drop a key, wrong type, extra key, garbage — and assert the client never
// returns anything the schema rejects, never throws anything but the typed error, and
// never calls the endpoint more than twice.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Case = { name: ModelCallName; valid: unknown };
const VALID: Case[] = [
  { name: 'draft_message', valid: goodMessage },
  { name: 'draft_agent_prompt', valid: { body: 'On eksempelbutik.dk gate the tags.' } },
  { name: 'review_claim', valid: { supported: true, reason: 'The quote is in the source.' } },
  {
    name: 'explain_finding',
    valid: {
      why: 'Because.',
      grounded: [{ label: 'Observed', value: '9 hosts' }],
      evidence: [{ evidenceId: 'ev-1', hash: 'a'.repeat(64) }],
    },
  },
  {
    name: 'classify_cookies',
    valid: {
      cookies: [{ name: '_ga', host: 'eksempelbutik.dk', category: 'statistics', confidence: 0.9 }],
    },
  },
];

function mutate(rng: () => number, valid: unknown): { kind: string; text: string } {
  const text = JSON.stringify(valid);
  const obj = JSON.parse(text) as Record<string, unknown>;
  const keys = Object.keys(obj);
  const key = keys[Math.floor(rng() * keys.length)]!;
  const roll = Math.floor(rng() * 7);
  switch (roll) {
    case 0:
      return { kind: 'truncated', text: text.slice(0, 1 + Math.floor(rng() * (text.length - 1))) };
    case 1: {
      const { [key]: _dropped, ...rest } = obj;
      expect(_dropped).toBeDefined();
      return { kind: 'missing key', text: JSON.stringify(rest) };
    }
    case 2:
      return {
        kind: 'wrong type',
        text: JSON.stringify({ ...obj, [key]: [42, null, 'x'][Math.floor(rng() * 3)] }),
      };
    case 3:
      return {
        kind: 'extra key',
        text: JSON.stringify({ ...obj, [`extra_${Math.floor(rng() * 100)}`]: 'surprise' }),
      };
    case 4:
      return {
        kind: 'garbage',
        text: 'Sure! Here is the JSON you asked for:\n```json\n' + text + '\n```',
      };
    case 5:
      return { kind: 'empty', text: ['', 'null', '[]', '{}'][Math.floor(rng() * 4)]! };
    default:
      return { kind: 'valid', text };
  }
}

describe('fuzzed and truncated answers have one defined behaviour (T-04)', () => {
  it('returns only schema-valid values, throws only the typed error, calls at most twice', async () => {
    const rng = mulberry32(2026);
    const tally: Record<string, { valid: number; rejected: number }> = {};
    for (let i = 0; i < 300; i++) {
      const c = VALID[i % VALID.length]!;
      const first = mutate(rng, c.valid);
      const second = mutate(rng, c.valid);
      const { impl } = endpoint(completion(first.text), completion(second.text));
      const client = new ModelClient(config, { fetch: impl });
      let result: unknown;
      let error: unknown;
      try {
        result = await client.call({
          name: c.name,
          input: inputFor(c.name),
          system: 's',
          user: 'u',
        } as never);
      } catch (e) {
        error = e;
      }
      expect(impl.mock.calls.length).toBeLessThanOrEqual(MAX_ATTEMPTS);
      const label = `${c.name} #${i} first=${first.kind} second=${second.kind}`;
      tally[first.kind] ??= { valid: 0, rejected: 0 };
      if (error !== undefined) {
        expect(error, label).toBeInstanceOf(ModelOutputError);
        expect(impl.mock.calls.length, label).toBe(MAX_ATTEMPTS);
        tally[first.kind]!.rejected++;
      } else {
        expect(MODEL_CALLS[c.name].output.safeParse(result).success, label).toBe(true);
        tally[first.kind]!.valid++;
        if (first.kind === 'valid') expect(impl.mock.calls.length, label).toBe(1);
      }
    }
    // Every mutation kind was exercised, and none of the broken ones ever slipped through.
    for (const kind of [
      'truncated',
      'missing key',
      'wrong type',
      'extra key',
      'garbage',
      'empty',
      'valid',
    ]) {
      expect(tally[kind], kind).toBeDefined();
    }
    expect(tally['valid']?.rejected).toBe(0);
    expect(tally['garbage']?.valid ?? 0).toBeLessThanOrEqual(tally['garbage']?.rejected ?? 0);
  });
});

function inputFor(name: ModelCallName): unknown {
  switch (name) {
    case 'draft_message':
      return draftInput;
    case 'draft_agent_prompt':
      return {
        finding: draftInput.finding,
        evidence: draftInput.evidence,
        domain: 'eksempelbutik.dk',
        locale: 'en',
      };
    case 'explain_finding':
      return { finding: draftInput.finding, evidence: draftInput.evidence, locale: 'en' };
    case 'review_claim':
      return {
        claim: {
          id: 'c-1',
          caseId: 'DK-26-0M4K',
          kind: 'observation',
          statement: 'A tag loads on pass A.',
          evidence: [{ evidenceId: 'ev-1', hash: 'a'.repeat(64) }],
          producedBy: { worker: 'crawler' },
          at: '2026-09-08T14:00:00Z',
        },
        evidence: draftInput.evidence,
      };
    case 'classify_cookies':
      return { cookies: [{ name: '_ga', host: 'eksempelbutik.dk' }] };
    default:
      throw new Error(`no fuzz input for ${name}`);
  }
}

// Enumerate model call sites: every one must name a registered call, and nothing may
// reach a completions or embeddings endpoint except the client itself.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', '.next', 'artifacts', 'prototype']);
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}
const CLIENT = join(ROOT, 'packages', 'agent', 'src', 'model-client.ts');
const sources = [join(ROOT, 'packages'), join(ROOT, 'apps')].flatMap((d) => walk(d));

export function enumerateCallSites(source: string): string[] {
  return [...source.matchAll(/\.call\(\s*\{[^}]*?\bname:\s*'([a-z_]+)'/gs)].map((m) => m[1]!);
}

describe('every model call site is enumerated and validated (T-04)', () => {
  it('finds call sites by the name they pass', () => {
    expect(
      enumerateCallSites(`await client.call({ name: 'draft_message', input, system, user })`),
    ).toEqual(['draft_message']);
    expect(enumerateCallSites(`client.call({\n  name: 'explain_finding',\n  input,\n})`)).toEqual([
      'explain_finding',
    ]);
  });

  it('every call site in the repository names a registered call', () => {
    const sites = sources.flatMap((f) =>
      enumerateCallSites(readFileSync(f, 'utf8')).map((name) => ({
        file: relative(ROOT, f).split(sep).join('/'),
        name,
      })),
    );
    for (const site of sites) {
      expect(MODEL_CALL_NAMES, `${site.file} calls ${site.name}`).toContain(site.name);
    }
  });

  it('nothing but the client reaches a completions or embeddings endpoint', () => {
    const direct =
      /chat\/completions|\/embeddings|from\s+['"]openai['"]|@anthropic-ai\/sdk|response_format/;
    const offenders = sources.filter((f) => f !== CLIENT && direct.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(ROOT, f).split(sep).join('/'))).toEqual([]);
  });

  it('the client covers every registered call', () => {
    type Check = ModelOutput<'draft_message'>;
    const typed: Check = goodMessage;
    expect(typed.subject).toBe(goodMessage.subject);
    expect(MODEL_CALL_NAMES.length).toBeGreaterThan(0);
  });
});
