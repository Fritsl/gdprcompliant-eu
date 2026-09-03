import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { EEA_COUNTRIES, isEea } from '@gc/contracts';
import {
  ConfigError,
  EgressError,
  EndpointSchema,
  assertOutboundAllowed,
  createOutboundFetch,
  isLocalHost,
  loadConfig,
  readEndpointsFile,
  redact,
} from '@gc/config';

const good = {
  NODE_ENV: 'test',
  APP_BASE_URL: 'https://gdprcompliant.eu',
  DATABASE_URL: 'postgres://gc:hunter2@localhost:5432/gdprcompliant',
  MODEL_BASE_URL: 'http://localhost:8000/v1',
  MODEL_API_KEY: 'sk-secret',
  MODEL_CHAT: 'llama-3.3-70b',
  MODEL_EMBEDDING: 'bge-m3',
};

const endpoints = [
  { host: 'eur-lex.europa.eu', purpose: 'corpus', jurisdiction: 'EU' },
  { host: 'datacvr.virk.dk', purpose: 'registry', jurisdiction: 'DK' },
  { host: 'llm.example.eu', purpose: 'model', jurisdiction: 'DK' },
];

describe('loadConfig (F-10)', () => {
  it('loads a complete environment', () => {
    const config = loadConfig(good, { endpoints });
    expect(config.env).toBe('test');
    expect(config.model.baseUrl).toBe('http://localhost:8000/v1');
    expect(config.model.chat).toBe('llama-3.3-70b');
    expect(config.scanner).toEqual({ concurrency: 2, egress: 'target-only' });
    expect(config.endpoints.map((e) => e.host)).toContain('datacvr.virk.dk');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('a missing variable fails at boot with a readable message naming it', () => {
    const { DATABASE_URL: _db, MODEL_CHAT: _chat, ...incomplete } = good;
    expect([_db, _chat]).toBeDefined();
    let error: unknown;
    try {
      loadConfig(incomplete, { endpoints });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const { message, problems } = error as ConfigError;
    expect(problems).toHaveLength(2);
    expect(message).toMatch(/DATABASE_URL: is not set — expected postgres:\/\/ connection string/);
    expect(message).toMatch(/MODEL_CHAT: is not set — expected chat model name/);
  });

  it('a malformed variable fails at boot, and every problem is reported together', () => {
    const bad = {
      ...good,
      MODEL_BASE_URL: 'not a url',
      SCAN_CONCURRENCY: 'lots',
      DATABASE_URL: 'mysql://x',
    };
    let error: ConfigError | undefined;
    try {
      loadConfig(bad, { endpoints });
    } catch (e) {
      error = e as ConfigError;
    }
    expect(error?.problems.map((p) => p.split(':')[0]).sort()).toEqual(
      ['DATABASE_URL', 'MODEL_BASE_URL', 'SCAN_CONCURRENCY'].sort(),
    );
    expect(error?.message).toMatch(/MODEL_BASE_URL: .*expected OpenAI-compatible base URL/);
  });

  it('never defaults a required value', () => {
    expect(() => loadConfig({}, { endpoints })).toThrow(ConfigError);
  });

  it('a model endpoint outside localhost must be declared, with purpose model', () => {
    expect(() =>
      loadConfig({ ...good, MODEL_BASE_URL: 'https://llm.somewhere.eu/v1' }, { endpoints }),
    ).toThrow(/MODEL_BASE_URL: host llm.somewhere.eu is not declared in the endpoint allowlist/);
    expect(() =>
      loadConfig({ ...good, MODEL_BASE_URL: 'https://datacvr.virk.dk/v1' }, { endpoints }),
    ).toThrow(/declared for registry, not model/);
    expect(
      loadConfig({ ...good, MODEL_BASE_URL: 'https://llm.example.eu/v1' }, { endpoints }).model
        .baseUrl,
    ).toBe('https://llm.example.eu/v1');
  });

  it('an endpoint outside the EEA is refused at boot', () => {
    const extra = JSON.stringify([
      { host: 'api.openai.com', purpose: 'model', jurisdiction: 'US' },
    ]);
    expect(() => loadConfig({ ...good, ENDPOINTS_EXTRA: extra }, { endpoints })).toThrow(
      /ENDPOINTS_EXTRA\.0\.jurisdiction: outside the EEA/,
    );
    expect(() => loadConfig({ ...good, ENDPOINTS_EXTRA: '{oops' }, { endpoints })).toThrow(
      /ENDPOINTS_EXTRA: is not valid JSON/,
    );
    expect(() =>
      loadConfig(good, { endpoints: [{ host: 'x.example', purpose: 'corpus' }] }),
    ).toThrow(/endpoints\.0\.jurisdiction/);
  });

  it('a host declared for two purposes is a boot failure', () => {
    const extra = JSON.stringify([
      { host: 'datacvr.virk.dk', purpose: 'corpus', jurisdiction: 'DK' },
    ]);
    expect(() => loadConfig({ ...good, ENDPOINTS_EXTRA: extra }, { endpoints })).toThrow(
      /datacvr.virk.dk is declared twice/,
    );
  });

  it('redacts secrets', () => {
    const shown = JSON.stringify(redact(loadConfig(good, { endpoints })));
    expect(shown).not.toContain('hunter2');
    expect(shown).not.toContain('sk-secret');
    expect(shown).toContain('llama-3.3-70b');
  });
});

describe('the checked-in endpoint allowlist', () => {
  it('declares a purpose and an EEA jurisdiction for every host', () => {
    const list = readEndpointsFile() as unknown[];
    expect(list.length).toBeGreaterThan(0);
    for (const entry of list) {
      const parsed = EndpointSchema.safeParse(entry);
      expect(parsed.success, JSON.stringify(entry)).toBe(true);
      expect(isEea(parsed.data!.jurisdiction)).toBe(true);
    }
    expect(loadConfig(good).endpoints.length).toBe(list.length);
  });

  it('the EEA is the 27 plus Iceland, Liechtenstein and Norway', () => {
    expect(EEA_COUNTRIES).toHaveLength(30);
    expect(isEea('EU')).toBe(true);
    expect(isEea('NO')).toBe(true);
    expect(isEea('US')).toBe(false);
    expect(isEea('GB')).toBe(false);
    expect(isEea('CH')).toBe(false);
  });
});

describe('egress', () => {
  const config = loadConfig(good, { endpoints });

  it('refuses an undeclared host before any bytes leave', async () => {
    const impl = vi.fn(async () => new Response('ok'));
    const outbound = createOutboundFetch(config, impl);
    await expect(outbound('https://api.openai.com/v1/chat', { purpose: 'model' })).rejects.toThrow(
      EgressError,
    );
    await expect(outbound('https://api.openai.com/v1/chat', { purpose: 'model' })).rejects.toThrow(
      /api.openai.com refused: not declared/,
    );
    expect(impl).not.toHaveBeenCalled();
  });

  it('refuses a declared host used for another purpose', async () => {
    const impl = vi.fn(async () => new Response('ok'));
    const outbound = createOutboundFetch(config, impl);
    await expect(outbound('https://datacvr.virk.dk/x', { purpose: 'model' })).rejects.toThrow(
      /declared for registry, not model/,
    );
    expect(impl).not.toHaveBeenCalled();
  });

  it('lets a declared host through, with the purpose stripped from the request', async () => {
    const impl = vi.fn(async () => new Response('ok'));
    const outbound = createOutboundFetch(config, impl);
    await outbound('https://datacvr.virk.dk/x', { purpose: 'registry', method: 'GET' });
    expect(impl).toHaveBeenCalledWith('https://datacvr.virk.dk/x', { method: 'GET' });
  });

  it('local hosts need no declaration', () => {
    for (const h of ['localhost', '127.0.0.1', 'llm.internal', 'db.local', 'app.localhost']) {
      expect(isLocalHost(h), h).toBe(true);
    }
    expect(isLocalHost('eur-lex.europa.eu')).toBe(false);
    expect(assertOutboundAllowed(config, 'http://localhost:8000/v1/chat', 'model')).toBeUndefined();
    expect(
      assertOutboundAllowed(config, 'https://eur-lex.europa.eu/x', 'corpus')?.jurisdiction,
    ).toBe('EU');
  });
});

// No code path can reach a host outside the allowlist: nothing outside the egress
// module may call fetch or an HTTP client directly. ESLint says the same; this is the
// belt to its braces.
describe('every outbound call goes through @gc/config', () => {
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
  const SKIP = new Set(['node_modules', 'dist', '.next', 'artifacts', 'prototype']);
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
    }
    return out;
  };
  const egress = join(ROOT, 'packages', 'config', 'src', 'egress.ts');
  // The fixture server (F-07) listens on a local port and never connects out.
  const fixtureServer = join(ROOT, 'packages', 'scanner', 'src', 'fixtures', 'server.ts');
  const files = [join(ROOT, 'packages'), join(ROOT, 'apps')]
    .flatMap((d) => walk(d))
    .filter((f) => f !== egress && f !== fixtureServer);

  it('no package or app calls fetch or an HTTP client directly', () => {
    const direct =
      /(?<![\w.$])fetch\s*\(|from\s+['"](?:undici|axios|got|node-fetch|node:https?|https?)['"]|require\(['"](?:undici|axios|got|node-fetch|node:https?|https?)['"]\)/;
    const offenders = files.filter((f) => direct.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(ROOT, f).split(sep).join('/'))).toEqual([]);
  });
});
