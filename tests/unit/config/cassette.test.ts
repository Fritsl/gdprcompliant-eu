import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CASSETTES_DIR,
  CassetteMissingError,
  EgressError,
  REDACTED,
  cassetteFile,
  cassetteHost,
  createRecordedFetch,
  loadConfig,
  redactHeaders,
  redactText,
  type Cassette,
} from '@gc/config';

const env = {
  NODE_ENV: 'test',
  APP_BASE_URL: 'https://gdprcompliant.eu',
  DATABASE_URL: 'postgres://gc:gc@localhost:5432/gc',
  MODEL_BASE_URL: 'http://localhost:8000/v1',
  MODEL_CHAT: 'chat',
  MODEL_EMBEDDING: 'embed',
};
const endpoints = [{ host: 'registry.test', purpose: 'registry', jurisdiction: 'DK' }];
const config = loadConfig(env, { endpoints });

const answer = (body: string, status = 200) =>
  vi.fn(
    async () =>
      new Response(body, {
        status,
        headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abc' },
      }),
  );

describe('network mode is configuration (F-09)', () => {
  it('defaults to replay, and only the three modes exist', () => {
    expect(config.network.mode).toBe('replay');
    expect(loadConfig({ ...env, GC_NETWORK: 'record' }, { endpoints }).network.mode).toBe('record');
    expect(() => loadConfig({ ...env, GC_NETWORK: 'yolo' }, { endpoints })).toThrow(/GC_NETWORK/);
  });
});

describe('replay', () => {
  it('a missing cassette is a hard error naming the file and the re-record command, never a live call', async () => {
    const impl = answer('{}');
    const dir = mkdtempSync(join(tmpdir(), 'cassettes-'));
    const outbound = createRecordedFetch(config, {
      name: 'registry-test',
      mode: 'replay',
      dir,
      impl,
    });
    const error = await outbound('http://registry.test/company/1', { purpose: 'registry' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CassetteMissingError);
    expect((error as Error).message).toMatch(
      /no cassette for http:\/\/registry.test\/company\/1 at .*registry-test/,
    );
    expect((error as Error).message).toMatch(/GC_NETWORK=record/);
    expect(impl).not.toHaveBeenCalled();
  });

  it('answers from the committed cassette without touching the network', async () => {
    const impl = vi.fn(async () => {
      throw new Error('the network cable is pulled');
    });
    const outbound = createRecordedFetch(config, { name: 'registry-test', impl });
    const response = await outbound('http://registry.test/company/12345678', {
      purpose: 'registry',
      headers: { accept: 'application/json', authorization: 'Bearer sk-live-secret' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      cvr: '12345678',
      name: 'Tømrer Jensen ApS',
      country: 'DK',
    });
    expect(impl).not.toHaveBeenCalled();
  });

  it('the allowlist still applies in replay: an undeclared host is refused before the cassette is looked up', async () => {
    const outbound = createRecordedFetch(config, { name: 'registry-test', impl: answer('{}') });
    await expect(outbound('http://api.openai.com/v1', { purpose: 'model' })).rejects.toThrow(
      CassetteMissingError,
    );
    const recording = createRecordedFetch(config, {
      name: 'x',
      mode: 'record',
      dir: mkdtempSync(join(tmpdir(), 'c-')),
      impl: answer('{}'),
    });
    await expect(recording('http://api.openai.com/v1', { purpose: 'model' })).rejects.toThrow(
      EgressError,
    );
  });
});

describe('record', () => {
  it('makes the call through the allowlist, writes a readable cassette, and replays it identically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cassettes-'));
    const impl = answer(
      '{"ok":true,"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop"}',
    );
    const recording = createRecordedFetch(config, {
      name: 'registry-test',
      mode: 'record',
      dir,
      impl,
      now: () => new Date('2026-09-03T12:00:00Z'),
    });
    const first = await recording('http://registry.test/company/1?token=sk-abcdefghijkl', {
      purpose: 'registry',
      method: 'POST',
      headers: { authorization: 'Bearer sk-live', 'x-api-key': 'k', accept: 'application/json' },
      body: '{"q":"sk-abcdefghijkl"}',
    });
    expect(first.status).toBe(200);
    expect(impl).toHaveBeenCalledTimes(1);

    const files = readdirSync(join(dir, 'registry-test'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^POST_registry\.test_company-1-token-.*_[0-9a-f]{12}\.json$/);
    const cassette = JSON.parse(
      readFileSync(join(dir, 'registry-test', files[0]!), 'utf8'),
    ) as Cassette;
    expect(cassette.recordedAt).toBe('2026-09-03T12:00:00.000Z');
    expect(cassette.request.headers).toEqual({
      authorization: REDACTED,
      'x-api-key': REDACTED,
      accept: 'application/json',
    });
    expect(cassette.request.url).toBe(`http://registry.test/company/1?token=${REDACTED}`);
    expect(cassette.request.body).toBe(`{"q":"${REDACTED}"}`);
    expect(cassette.response.headers['set-cookie']).toBe(REDACTED);
    expect(cassette.response.body).toBe(`{"ok":true,"token":"${REDACTED}"}`);
    const text = readFileSync(join(dir, 'registry-test', files[0]!), 'utf8');
    for (const secret of ['sk-live', 'sk-abcdefghijkl', 'eyJhbGci', 'sid=abc'])
      expect(text).not.toContain(secret);

    const replaying = createRecordedFetch(config, {
      name: 'registry-test',
      mode: 'replay',
      dir,
      impl,
    });
    const second = await replaying('http://registry.test/company/1?token=sk-abcdefghijkl', {
      purpose: 'registry',
      method: 'POST',
      body: '{"q":"sk-abcdefghijkl"}',
    });
    expect(await second.json()).toEqual({ ok: true, token: REDACTED });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('live makes the call and writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cassettes-'));
    const impl = answer('{}');
    await createRecordedFetch(config, { name: 'canary', mode: 'live', dir, impl })(
      'http://registry.test/x',
      { purpose: 'registry' },
    );
    expect(impl).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, 'canary'))).toBe(false);
  });
});

describe('cassette files', () => {
  it('are named readably and keyed on method, url and body', () => {
    const a = cassetteFile('get', 'http://registry.test/company/12345678', null);
    expect(a).toMatch(/^GET_registry\.test_company-12345678_[0-9a-f]{12}\.json$/);
    expect(cassetteFile('GET', 'http://registry.test/company/12345678', null)).toBe(a);
    expect(cassetteFile('GET', 'http://registry.test/company/12345679', null)).not.toBe(a);
    expect(cassetteFile('POST', 'http://registry.test/company/12345678', null)).not.toBe(a);
    expect(cassetteFile('GET', 'http://registry.test/company/12345678', '{}')).not.toBe(a);
    expect(cassetteFile('GET', 'http://registry.test/', null)).toMatch(/^GET_registry\.test_root_/);
  });

  it('the committed cassettes are redacted and talk only to declared or test hosts', () => {
    const dirs = readdirSync(CASSETTES_DIR).filter((d) => !d.endsWith('.md'));
    expect(dirs).toContain('registry-test');
    for (const d of dirs) {
      for (const f of readdirSync(join(CASSETTES_DIR, d))) {
        const file = join(CASSETTES_DIR, d, f);
        const text = readFileSync(file, 'utf8');
        expect(text).not.toMatch(/Bearer\s+(?!\[redacted\])\S/);
        expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
        expect(cassetteHost(file)).toMatch(/\.(test|eu|dk|de)$/);
        expect(f).toBe(
          cassetteFile(
            JSON.parse(text).request.method,
            JSON.parse(text).request.url,
            JSON.parse(text).request.body,
          ),
        );
      }
    }
  });

  it('redaction covers headers by name and values by shape', () => {
    expect(
      redactHeaders([
        ['Authorization', 'Bearer x'],
        ['Accept', 'text/html'],
        ['X-Session-Id', '1'],
      ]),
    ).toEqual({
      authorization: REDACTED,
      accept: 'text/html',
      'x-session-id': REDACTED,
    });
    expect(redactText('token=sk-abcdefghijklmnop&x=1')).toBe(`token=${REDACTED}&x=1`);
    expect(redactText('nothing to see')).toBe('nothing to see');
  });
});
