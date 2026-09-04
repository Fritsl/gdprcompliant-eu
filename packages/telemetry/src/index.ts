// @gc/telemetry — traces, structured events and metrics (O-04), with no dependency
// and one rule: nothing personal leaves through here. Every record passes the redactor
// before any sink sees it; a sink is a function that takes a line. The worker writes
// JSON lines to stdout; a test keeps them in memory and reads them back.

export const PACKAGE = '@gc/telemetry';

export type RecordKind = 'span' | 'event' | 'metric';
export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Fields = Readonly<Record<string, unknown>>;

export interface TelemetryRecord {
  readonly kind: RecordKind;
  readonly name: string;
  readonly at: string;
  readonly level: Level;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentId?: string;
  readonly durationMs?: number;
  readonly value?: number;
  readonly fields: Fields;
}

export interface Sink {
  write(record: TelemetryRecord): void;
}

export class MemorySink implements Sink {
  readonly records: TelemetryRecord[] = [];
  write(record: TelemetryRecord): void {
    this.records.push(record);
  }
  clear(): void {
    this.records.length = 0;
  }
  byTrace(traceId: string): TelemetryRecord[] {
    return this.records.filter((r) => r.traceId === traceId);
  }
  named(name: string): TelemetryRecord[] {
    return this.records.filter((r) => r.name === name);
  }
}

// One JSON object per line, in order; what a log shipper reads.
export class JsonLinesSink implements Sink {
  constructor(
    private readonly out: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  ) {}
  write(record: TelemetryRecord): void {
    this.out(JSON.stringify(record));
  }
}

// ---- redaction ---------------------------------------------------------------------

export const REDACTED = '[redacted]';

// Keys that name a person or a secret are dropped whatever they hold; keys that carry
// page text or bodies are dropped because a body can hold anything.
const DROP_KEY =
  /^(e-?mail|name|firstName|lastName|fullName|phone|telephone|mobile|address|street|ip|ipAddress|remoteAddress|token|accessToken|apiKey|api_key|authorization|password|secret|cookie|cookies|body|text|html|raw|quote|content|answer|requestedBy)$/i;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const CPR = /\b\d{6}-?\d{4}\b/g;
const PHONE = /(?<![\w/.-])(\+\d{1,3}[ -]?)?(\d[ -]?){8,}\d(?![\w/.-])/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const BEARER = /\bbearer\s+\S+/gi;
const JWT = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g;
const QUERY = /\?[^\s"']*/g;
const MAX_STRING = 300;

export function redactString(s: string): string {
  let out = s
    .replace(BEARER, REDACTED)
    .replace(JWT, REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(CPR, REDACTED)
    .replace(IPV4, REDACTED)
    .replace(PHONE, REDACTED)
    .replace(QUERY, `?${REDACTED}`);
  if (out.length > MAX_STRING)
    out = `${out.slice(0, MAX_STRING)}…[+${out.length - MAX_STRING} chars]`;
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEY.test(k)) out[k] = REDACTED;
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

// ---- the registry of metrics ---------------------------------------------------------

const key = (name: string, tags: Fields): string =>
  `${name}|${Object.keys(tags)
    .sort()
    .map((k) => `${k}=${String(tags[k])}`)
    .join(',')}`;

export interface MetricSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly histograms: Readonly<
    Record<string, { count: number; sum: number; min: number; max: number }>
  >;
}

export class Metrics {
  readonly #counters = new Map<string, number>();
  readonly #histograms = new Map<string, number[]>();

  counter(name: string, tags: Fields = {}, by = 1): void {
    const k = key(name, tags);
    this.#counters.set(k, (this.#counters.get(k) ?? 0) + by);
  }
  observe(name: string, value: number, tags: Fields = {}): void {
    const k = key(name, tags);
    this.#histograms.set(k, [...(this.#histograms.get(k) ?? []), value]);
  }
  count(name: string, tags: Fields = {}): number {
    return this.#counters.get(key(name, tags)) ?? 0;
  }
  snapshot(): MetricSnapshot {
    const histograms: Record<string, { count: number; sum: number; min: number; max: number }> = {};
    for (const [k, values] of this.#histograms)
      histograms[k] = {
        count: values.length,
        sum: values.reduce((a, b) => a + b, 0),
        min: Math.min(...values),
        max: Math.max(...values),
      };
    return { counters: Object.fromEntries(this.#counters), histograms };
  }
  reset(): void {
    this.#counters.clear();
    this.#histograms.clear();
  }
}

// ---- the one telemetry --------------------------------------------------------------

let current: Sink = new JsonLinesSink();
let clock: () => Date = () => new Date();
export const metrics = new Metrics();

export function setSink(sink: Sink): void {
  current = sink;
}
export function sink(): Sink {
  return current;
}
export function setClock(now: () => Date): void {
  clock = now;
}

export interface TraceContext {
  readonly traceId?: string | undefined;
  readonly parentId?: string | undefined;
}

let counter = 0;
const newId = (): string => `${Date.now().toString(36)}-${(++counter).toString(36)}`;

function emit(record: Omit<TelemetryRecord, 'at' | 'fields'> & { fields?: Fields }): void {
  current.write({
    ...record,
    at: clock().toISOString(),
    fields: (redact(record.fields ?? {}) as Fields) ?? {},
  });
}

export function event(
  name: string,
  fields: Fields = {},
  ctx: TraceContext = {},
  level: Level = 'info',
): void {
  emit({
    kind: 'event',
    name,
    level,
    ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
    ...(ctx.parentId ? { parentId: ctx.parentId } : {}),
    fields,
  });
}

// A metric is both a record (for the line) and a registry update (for the dashboard).
export function metric(
  name: string,
  value: number,
  tags: Fields = {},
  ctx: TraceContext = {},
): void {
  metrics.observe(name, value, tags);
  emit({
    kind: 'metric',
    name,
    level: 'info',
    value,
    ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
    fields: tags,
  });
}

export function count(name: string, tags: Fields = {}, by = 1): void {
  metrics.counter(name, tags, by);
}

export interface SpanContext extends TraceContext {
  readonly traceId: string;
  readonly spanId: string;
}

// A span is what happened between two instants: it lands when the work ends, with its
// duration and whether it threw. The error's name and message are kept, redacted.
export async function span<T>(
  name: string,
  fields: Fields,
  work: (ctx: SpanContext) => Promise<T>,
  ctx: TraceContext = {},
): Promise<T> {
  const traceId = ctx.traceId ?? newId();
  const spanId = newId();
  const started = Date.now();
  const context: SpanContext = {
    traceId,
    spanId,
    ...(ctx.parentId ? { parentId: ctx.parentId } : {}),
  };
  try {
    const result = await work(context);
    emit({
      kind: 'span',
      name,
      level: 'info',
      traceId,
      spanId,
      ...(ctx.parentId ? { parentId: ctx.parentId } : {}),
      durationMs: Date.now() - started,
      fields: { ...fields, outcome: 'ok' },
    });
    return result;
  } catch (e) {
    emit({
      kind: 'span',
      name,
      level: 'error',
      traceId,
      spanId,
      ...(ctx.parentId ? { parentId: ctx.parentId } : {}),
      durationMs: Date.now() - started,
      fields: { ...fields, outcome: 'error', error: e instanceof Error ? e : String(e) },
    });
    throw e;
  }
}

// A counter summed over every tag set that carries the given tag.
const sumWhere = (name: string, tag: string): number =>
  Object.entries(metrics.snapshot().counters)
    .filter(([k]) => k.startsWith(`${name}|`) && (k.split('|')[1] ?? '').split(',').includes(tag))
    .reduce((n, [, v]) => n + v, 0);

// The verifier gate as a dashboard number: what share of claims it rejected. A sudden
// drop towards zero is the gate breaking, not the model improving.
export function verifierRejectionRate(): { claims: number; rejected: number; rate: number } {
  const rejected = sumWhere('verifier.claim', 'verdict=rejected');
  const accepted = sumWhere('verifier.claim', 'verdict=accepted');
  const claims = rejected + accepted;
  return { claims, rejected, rate: claims === 0 ? 0 : rejected / claims };
}
