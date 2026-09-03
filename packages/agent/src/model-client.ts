import {
  ChatCompletionResponseSchema,
  EmbeddingInputSchema,
  EmbeddingResponseSchema,
  MODEL_CALLS,
  modelOutputJsonSchema,
  parseModelOutput,
  type ModelCallName,
  type ModelInput,
  type ModelOutput,
} from '@gc/contracts';
import {
  EgressError,
  createOutboundFetch,
  type Config,
  type FetchLike,
  type OutboundFetch,
} from '@gc/config';

// The only door to a model (T-04). Every call names an entry in the contracts registry;
// the input is validated before anything is sent, the output is validated before
// anything is returned, and a malformed answer has one defined behaviour: retry once
// with the schema issues fed back, then fail loudly with both attempts on record.
//
// Nothing else in the repository may talk to a completions or embeddings endpoint —
// tests/unit/agent/schema-conformance.test.ts scans for it.

export const MAX_ATTEMPTS = 2;
const RAW_LIMIT = 2_000;

export interface ModelAttempt {
  readonly call: string;
  readonly attempt: number;
  readonly issues: readonly string[];
  // The model's raw answer, truncated. For the review queue, never for parsing.
  readonly raw: string;
}

export class ModelInputError extends Error {
  constructor(
    public readonly call: ModelCallName,
    public readonly issues: readonly string[],
  ) {
    super(`${call}: input does not match its schema — ${issues.join('; ')}`);
    this.name = 'ModelInputError';
  }
}

export class ModelOutputError extends Error {
  constructor(
    public readonly call: string,
    public readonly attempts: readonly ModelAttempt[],
  ) {
    const last = attempts[attempts.length - 1];
    super(
      `${call}: model output did not match its schema after ${attempts.length} attempts — ${last?.issues.join('; ') ?? 'no attempts'}`,
    );
    this.name = 'ModelOutputError';
  }
}

export class ModelTransportError extends Error {
  constructor(
    public readonly call: string,
    public readonly attempts: readonly ModelAttempt[],
  ) {
    const last = attempts[attempts.length - 1];
    super(
      `${call}: model endpoint unreachable after ${attempts.length} attempts — ${last?.issues.join('; ')}`,
    );
    this.name = 'ModelTransportError';
  }
}

export interface ModelRequest<N extends ModelCallName> {
  readonly name: N;
  readonly input: ModelInput<N>;
  // The prompt. Anything scraped inside it arrives wrapped as UntrustedContent in the
  // input and is delimited by the prompt builder (A-10); this client does not look.
  readonly system: string;
  readonly user: string;
  // For deterministic replay where the endpoint supports it.
  readonly seed?: number;
}

export interface ModelClientOptions {
  // Defaults to the real fetch, behind the endpoint allowlist. Tests inject a stub.
  readonly fetch?: FetchLike;
  readonly onAttempt?: (attempt: ModelAttempt) => void;
}

type Outcome<T> =
  { ok: true; value: T } | { ok: false; transport: boolean; issues: string[]; raw: string };

interface Message {
  role: 'system' | 'user';
  content: string;
}

export class ModelClient {
  private readonly outbound: OutboundFetch;
  private readonly onAttempt: ((attempt: ModelAttempt) => void) | undefined;

  constructor(
    private readonly config: Config,
    options: ModelClientOptions = {},
  ) {
    this.outbound = createOutboundFetch(config, options.fetch);
    this.onAttempt = options.onAttempt;
  }

  async call<N extends ModelCallName>(request: ModelRequest<N>): Promise<ModelOutput<N>> {
    const { name } = request;
    const input = MODEL_CALLS[name].input.safeParse(request.input);
    if (!input.success) {
      throw new ModelInputError(
        name,
        input.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`),
      );
    }

    const schema = modelOutputJsonSchema(name);
    const messages: Message[] = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ];
    const attempts: ModelAttempt[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const previous = attempts[attempts.length - 1];
      const body = {
        model: this.config.model.chat,
        temperature: 0,
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
        messages:
          previous && !previous.issues[0]?.startsWith('transport:')
            ? [...messages, retryNote(previous)]
            : messages,
        response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } },
      };
      const outcome = await this.post('chat/completions', body, (text) =>
        this.parseCompletion(name, text),
      );
      if (outcome.ok) return outcome.value;
      const record: ModelAttempt = {
        call: name,
        attempt,
        issues: outcome.issues,
        raw: outcome.raw.slice(0, RAW_LIMIT),
      };
      attempts.push(record);
      this.onAttempt?.(record);
    }

    if (attempts.every((a) => a.issues[0]?.startsWith('transport:')))
      throw new ModelTransportError(name, attempts);
    throw new ModelOutputError(name, attempts);
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const input = EmbeddingInputSchema.safeParse(texts);
    if (!input.success) {
      throw new ModelInputError(
        'embed' as ModelCallName,
        input.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`),
      );
    }
    const attempts: ModelAttempt[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const body = { model: this.config.model.embedding, input: input.data };
      const outcome = await this.post('embeddings', body, (text) =>
        parseEmbeddings(text, input.data.length),
      );
      if (outcome.ok) return outcome.value;
      const record: ModelAttempt = {
        call: 'embed',
        attempt,
        issues: outcome.issues,
        raw: outcome.raw.slice(0, RAW_LIMIT),
      };
      attempts.push(record);
      this.onAttempt?.(record);
    }
    if (attempts.every((a) => a.issues[0]?.startsWith('transport:')))
      throw new ModelTransportError('embed', attempts);
    throw new ModelOutputError('embed', attempts);
  }

  private async post<T>(
    path: string,
    body: unknown,
    parse: (text: string) => Outcome<T>,
  ): Promise<Outcome<T>> {
    const base = this.config.model.baseUrl.endsWith('/')
      ? this.config.model.baseUrl
      : `${this.config.model.baseUrl}/`;
    const url = new URL(path, base);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.model.apiKey !== undefined)
      headers['authorization'] = `Bearer ${this.config.model.apiKey}`;

    let response: Response;
    try {
      response = await this.outbound(url, {
        purpose: 'model',
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      // A refused host is a configuration fault, not a model fault: it does not retry.
      if (e instanceof EgressError) throw e;
      return {
        ok: false,
        transport: true,
        issues: [`transport: ${(e as Error).message}`],
        raw: '',
      };
    }
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        transport: true,
        issues: [`transport: HTTP ${response.status}`],
        raw: text,
      };
    }
    return parse(text);
  }

  private parseCompletion<N extends ModelCallName>(name: N, text: string): Outcome<ModelOutput<N>> {
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      return { ok: false, transport: false, issues: ['response is not JSON'], raw: text };
    }
    const parsed = ChatCompletionResponseSchema.safeParse(envelope);
    if (!parsed.success) {
      return {
        ok: false,
        transport: false,
        issues: ['response is not a chat completion'],
        raw: text,
      };
    }
    const choice = parsed.data.choices[0]!;
    const content = choice.message.content ?? '';
    if (choice.finish_reason === 'length') {
      return {
        ok: false,
        transport: false,
        issues: ['output truncated (finish_reason=length)'],
        raw: content,
      };
    }
    const output = parseModelOutput(name, content);
    if (!output.ok) return { ok: false, transport: false, issues: output.issues, raw: content };
    return { ok: true, value: output.value };
  }
}

function retryNote(previous: ModelAttempt): Message {
  return {
    role: 'system',
    content: `Your previous answer was rejected: ${previous.issues.join('; ')}. Reply with a single JSON object that matches the schema exactly, and nothing else.`,
  };
}

function parseEmbeddings(text: string, expected: number): Outcome<number[][]> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { ok: false, transport: false, issues: ['response is not JSON'], raw: text };
  }
  const parsed = EmbeddingResponseSchema.safeParse(envelope);
  if (!parsed.success)
    return {
      ok: false,
      transport: false,
      issues: ['response is not an embedding list'],
      raw: text,
    };
  if (parsed.data.data.length !== expected) {
    return {
      ok: false,
      transport: false,
      issues: [`expected ${expected} embeddings, got ${parsed.data.data.length}`],
      raw: text,
    };
  }
  const vectors = [...parsed.data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  const width = vectors[0]?.length ?? 0;
  if (vectors.some((v) => v.length !== width)) {
    return { ok: false, transport: false, issues: ['embeddings have different widths'], raw: text };
  }
  return { ok: true, value: vectors };
}
