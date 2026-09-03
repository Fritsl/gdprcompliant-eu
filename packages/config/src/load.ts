import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { hostOf, isLocalHost } from './egress.js';
import {
  ConfigSchema,
  EndpointSchema,
  EnvSchema,
  SECRET_KEYS,
  type Config,
  type Endpoint,
} from './schema.js';

// Load and validate configuration. Call this first thing at boot and nowhere else;
// pass the result down. Every problem is collected and reported together, named by
// the variable that caused it, so one restart fixes the lot.

export const ENDPOINTS_FILE = new URL('../endpoints.json', import.meta.url);

export class ConfigError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Configuration is not usable:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function readEndpointsFile(url: URL = ENDPOINTS_FILE): unknown {
  return JSON.parse(readFileSync(url, 'utf8'));
}

function describeIssue(prefix: string, issue: z.core.$ZodIssue): string {
  const where = issue.path.length > 0 ? issue.path.map(String).join('.') : prefix;
  const label = prefix && issue.path.length > 0 ? `${prefix}.${where}` : where;
  return `${label}: ${issue.message}`;
}

export interface LoadOptions {
  // Defaults to the checked-in endpoints.json. Tests pass their own.
  endpoints?: unknown;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadOptions = {},
): Config {
  const problems: string[] = [];

  const parsedEnv = EnvSchema.safeParse(env);
  if (!parsedEnv.success) {
    for (const issue of parsedEnv.error.issues) {
      const key = issue.path.map(String).join('.');
      const expectation = EnvSchema.shape[key as keyof typeof EnvSchema.shape]?.description;
      const missing = issue.code === 'invalid_type' && env[key] === undefined;
      problems.push(
        `${key}: ${missing ? 'is not set' : issue.message}${expectation ? ` — expected ${expectation}` : ''}`,
      );
    }
  }

  const endpoints: Endpoint[] = [];
  const declared = z.array(EndpointSchema).safeParse(options.endpoints ?? readEndpointsFile());
  if (declared.success) endpoints.push(...declared.data);
  else for (const issue of declared.error.issues) problems.push(describeIssue('endpoints', issue));

  if (parsedEnv.success && parsedEnv.data.ENDPOINTS_EXTRA !== undefined) {
    let extra: unknown;
    try {
      extra = JSON.parse(parsedEnv.data.ENDPOINTS_EXTRA);
      const parsedExtra = z.array(EndpointSchema).safeParse(extra);
      if (parsedExtra.success) endpoints.push(...parsedExtra.data);
      else
        for (const issue of parsedExtra.error.issues)
          problems.push(describeIssue('ENDPOINTS_EXTRA', issue));
    } catch {
      problems.push(
        'ENDPOINTS_EXTRA: is not valid JSON — expected a JSON array of {host, purpose, jurisdiction}',
      );
    }
  }

  const seen = new Map<string, Endpoint>();
  for (const e of endpoints) {
    const key = e.host.toLowerCase();
    const other = seen.get(key);
    if (other && other.purpose !== e.purpose) {
      problems.push(
        `endpoints: ${e.host} is declared twice, for ${other.purpose} and ${e.purpose}`,
      );
    }
    seen.set(key, e);
  }

  if (parsedEnv.success) {
    const { MODEL_BASE_URL, DATABASE_URL } = parsedEnv.data;
    requireDeclared(problems, seen, 'MODEL_BASE_URL', MODEL_BASE_URL, 'model');
    requireDeclared(problems, seen, 'DATABASE_URL', DATABASE_URL, 'database');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const e = parsedEnv.data as z.infer<typeof EnvSchema>;
  const config = ConfigSchema.parse({
    env: e.NODE_ENV,
    app: { baseUrl: e.APP_BASE_URL },
    database: { url: e.DATABASE_URL },
    model: {
      baseUrl: e.MODEL_BASE_URL,
      ...(e.MODEL_API_KEY !== undefined ? { apiKey: e.MODEL_API_KEY } : {}),
      chat: e.MODEL_CHAT,
      embedding: e.MODEL_EMBEDDING,
    },
    scanner: { concurrency: e.SCAN_CONCURRENCY, egress: 'target-only' },
    endpoints: [...seen.values()],
  });
  return Object.freeze(config);
}

function requireDeclared(
  problems: string[],
  declared: Map<string, Endpoint>,
  variable: string,
  url: string,
  purpose: Endpoint['purpose'],
): void {
  let host: string;
  try {
    host = hostOf(url);
  } catch {
    return; // already reported as malformed
  }
  if (isLocalHost(host)) return;
  const endpoint = declared.get(host);
  if (!endpoint) {
    problems.push(
      `${variable}: host ${host} is not declared in the endpoint allowlist — add it to endpoints.json or ENDPOINTS_EXTRA with purpose ${purpose} and its jurisdiction`,
    );
  } else if (endpoint.purpose !== purpose) {
    problems.push(`${variable}: host ${host} is declared for ${endpoint.purpose}, not ${purpose}`);
  }
}

// A copy safe to log or show on an internal status page: secrets replaced, the
// database password gone.
export function redact(config: Config): Record<string, unknown> {
  const dbUrl = new URL(config.database.url);
  if (dbUrl.password) dbUrl.password = '••••';
  return {
    env: config.env,
    app: config.app,
    database: { url: dbUrl.toString() },
    model: { ...config.model, ...(config.model.apiKey !== undefined ? { apiKey: '••••' } : {}) },
    scanner: config.scanner,
    endpoints: config.endpoints,
    secretKeys: [...SECRET_KEYS],
  };
}
