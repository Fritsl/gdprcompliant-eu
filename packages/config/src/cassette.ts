import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createOutboundFetch,
  hostOf,
  type FetchLike,
  type OutboundFetch,
  type OutboundInit,
} from './egress.js';
import type { Config } from './schema.js';

// Record and replay for every outbound call (F-09). Wraps the allowlisted fetch, so the
// endpoint rules still apply; adds a cassette per request under fixtures/cassettes/<name>/.
//
//   replay   answer from the cassette; a missing one is an error, never a live call
//   record   make the live call, write the cassette (redacted), return the answer
//   live     make the live call, write nothing — the canary, and nothing else
//
// The mode comes from config (GC_NETWORK), and the default is replay: a test that reaches
// for the network without a cassette fails in front of the developer, not silently in CI.

export const CASSETTES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/cassettes/',
);

export type NetworkMode = Config['network']['mode'];

export interface Cassette {
  readonly recordedAt: string;
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string | null;
  };
  readonly response: {
    readonly status: number;
    readonly statusText: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  };
}

export class CassetteMissingError extends Error {
  constructor(
    public readonly cassette: string,
    public readonly url: string,
  ) {
    super(
      `no cassette for ${url} at ${cassette} — replay mode makes no live calls. Re-record with GC_NETWORK=record (see TESTING.md).`,
    );
    this.name = 'CassetteMissingError';
  }
}

// Anything that looks like a credential is replaced before a cassette is written.
const SECRET_HEADER = /authorization|cookie|token|secret|key|session|password|credential/i;
const SECRET_VALUE =
  /\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
export const REDACTED = '[redacted]';

export function redactHeaders(headers: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    out[name.toLowerCase()] = SECRET_HEADER.test(name) ? REDACTED : redactText(value);
  }
  return out;
}

export function redactText(text: string): string {
  return text.replace(SECRET_VALUE, REDACTED);
}

function headerEntries(init: RequestInit | undefined): [string, string][] {
  const h = init?.headers;
  if (!h) return [];
  if (h instanceof Headers) {
    const out: [string, string][] = [];
    h.forEach((value, key) => out.push([key, value]));
    return out;
  }
  if (Array.isArray(h)) return h.map(([k, v]) => [k, v] as [string, string]);
  return Object.entries(h).map(
    ([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)] as [string, string],
  );
}

function bodyText(init: RequestInit | undefined): string | null {
  const b = init?.body;
  if (b === undefined || b === null) return null;
  if (typeof b === 'string') return b;
  return String(b);
}

// One file per distinct request: readable name, then a hash of what makes it distinct.
export function cassetteFile(method: string, url: string | URL, body: string | null): string {
  const u = typeof url === 'string' ? new URL(url) : url;
  const slug = `${u.pathname}${u.search}`
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const hash = createHash('sha256')
    .update(`${method.toUpperCase()} ${u.toString()}\n${body ?? ''}`)
    .digest('hex')
    .slice(0, 12);
  return `${method.toUpperCase()}_${u.hostname}_${slug || 'root'}_${hash}.json`;
}

export interface RecordedFetchOptions {
  // Namespace under fixtures/cassettes, e.g. 'registry-cvr'. One per adapter.
  readonly name: string;
  readonly mode?: NetworkMode;
  readonly dir?: string;
  readonly impl?: FetchLike;
  readonly now?: () => Date;
}

export function createRecordedFetch(config: Config, options: RecordedFetchOptions): OutboundFetch {
  const mode = options.mode ?? config.network.mode;
  const dir = join(options.dir ?? CASSETTES_DIR, options.name);
  const live = createOutboundFetch(config, options.impl);
  const now = options.now ?? (() => new Date());

  return async (url: string | URL, init: OutboundInit): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = bodyText(init);
    const file = join(dir, cassetteFile(method, url, body));

    if (mode === 'replay') {
      if (!existsSync(file)) throw new CassetteMissingError(file, String(url));
      const cassette = JSON.parse(readFileSync(file, 'utf8')) as Cassette;
      return new Response(cassette.response.body, {
        status: cassette.response.status,
        statusText: cassette.response.statusText,
        headers: cassette.response.headers,
      });
    }

    const response = await live(url, init);
    if (mode === 'live') return response;

    // record: the allowlist ran inside `live`; now keep what came back, minus secrets.
    const text = await response.text();
    const cassette: Cassette = {
      recordedAt: now().toISOString(),
      request: {
        method,
        url: redactText(String(url)),
        headers: redactHeaders(headerEntries(init)),
        body: body === null ? null : redactText(body),
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: redactHeaders(headerEntries({ headers: response.headers })),
        body: redactText(text),
      },
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(cassette, null, 2)}\n`);
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: cassette.response.headers,
    });
  };
}

// For the gate and the docs: which host a cassette talks to.
export function cassetteHost(file: string): string {
  return hostOf((JSON.parse(readFileSync(file, 'utf8')) as Cassette).request.url);
}
