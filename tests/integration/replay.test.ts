import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CassetteMissingError, createRecordedFetch, loadConfig, type FetchLike } from '@gc/config';
import { FixtureServer } from '@gc/scanner';

// Record against a local server standing in for a registry, then replay with the cable
// pulled. The same call, the same answer, and nothing on the wire the second time.

const config = loadConfig(
  {
    NODE_ENV: 'test',
    APP_BASE_URL: 'https://gdprcompliant.eu',
    DATABASE_URL: 'postgres://gc:gc@localhost:5432/gc',
    MODEL_BASE_URL: 'http://localhost:8000/v1',
    MODEL_CHAT: 'chat',
    MODEL_EMBEDDING: 'embed',
  },
  { endpoints: [{ host: 'registry.test', purpose: 'registry', jurisdiction: 'DK' }] },
);

let server: FixtureServer;

beforeAll(async () => {
  // A stand-in registry: one host, one JSON answer.
  const dir = mkdtempSync(join(tmpdir(), 'registry-'));
  server = await new FixtureServer([
    {
      host: 'registry.test',
      dir,
      routes: [
        {
          path: '/company/12345678',
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"cvr":"12345678","name":"Tømrer Jensen ApS"}',
        },
      ],
    },
  ]).start();
});

afterAll(async () => {
  await server?.stop();
});

// Route registry.test to the local server the way a proxy would. fetch refuses to set
// Host, so the original host travels in X-Forwarded-Host.
const viaFixtureServer: FetchLike = (url, init) => {
  const u = new URL(String(url));
  const local = `http://127.0.0.1:${server.port}${u.pathname}${u.search}`;
  return fetch(local, {
    ...init,
    headers: { ...(init?.headers as Record<string, string>), 'x-forwarded-host': u.host },
  });
};

describe('record, then replay with the cable pulled (F-09)', () => {
  it('records a cassette from the live call and replays it without the network', async () => {
    const cassettes = mkdtempSync(join(tmpdir(), 'cassettes-'));
    const url = 'http://registry.test/company/12345678';

    const recording = createRecordedFetch(config, {
      name: 'registry-test',
      mode: 'record',
      dir: cassettes,
      impl: viaFixtureServer,
    });
    const live = await recording(url, {
      purpose: 'registry',
      headers: { accept: 'application/json' },
    });
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ cvr: '12345678', name: 'Tømrer Jensen ApS' });
    expect(readdirSync(join(cassettes, 'registry-test'))).toHaveLength(1);
    expect(server.served.filter((s) => s.host === 'registry.test')).toHaveLength(1);

    const pulled = vi.fn<FetchLike>(async () => {
      throw new Error('the network cable is pulled');
    });
    const replaying = createRecordedFetch(config, {
      name: 'registry-test',
      mode: 'replay',
      dir: cassettes,
      impl: pulled,
    });
    const replayed = await replaying(url, {
      purpose: 'registry',
      headers: { accept: 'application/json' },
    });
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual({ cvr: '12345678', name: 'Tømrer Jensen ApS' });
    expect(pulled).not.toHaveBeenCalled();
    expect(server.served.filter((s) => s.host === 'registry.test')).toHaveLength(1);

    await expect(
      replaying('http://registry.test/company/99', { purpose: 'registry' }),
    ).rejects.toThrow(CassetteMissingError);
    expect(pulled).not.toHaveBeenCalled();
  });

  it('without GC_NETWORK the mode is replay: nothing goes live by accident', () => {
    expect(config.network.mode).toBe('replay');
  });
});
