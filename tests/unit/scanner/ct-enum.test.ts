import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cassetteFile, createRecordedFetch, loadConfig } from '@gc/config';
import { CtEnumerationSchema } from '@gc/contracts';
import { loadCatalogue } from '@gc/remedies';
import {
  CT_MIRROR,
  DEFAULT_HOST_CAP,
  classifyHost,
  enumerateCertificates,
  hostsFromEntries,
} from '@gc/scanner';

// Certificate transparency enumeration without a network (D-02): names classified by
// what they suggest, duplicates and wildcards handled, the list capped, and a finding
// that describes exposure without asserting a breach.

const identity = {
  tenantId: 't-1',
  caseId: 'DK-26-0M4K',
  scanId: 'scan-1',
  capturedAt: '2026-09-04T09:14:00Z',
};

const config = loadConfig({
  DATABASE_URL: 'postgres://gc:gc@localhost:5432/gdprcompliant',
  MODEL_BASE_URL: 'http://localhost:8000/v1',
  MODEL_API_KEY: 'x',
  MODEL_CHAT: 'chat-model',
  MODEL_EMBEDDING: 'embedding-model',
  APP_BASE_URL: 'https://gdprcompliant.eu',
  GC_NETWORK: 'replay',
});

// A cassette written by hand: the mirror's answer for a domain that never existed.
function cassetteFor(domain: string, entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-'));
  const url = `${CT_MIRROR}/?q=${encodeURIComponent(`%.${domain}`)}&output=json`;
  mkdirSync(join(dir, 'ct'), { recursive: true });
  writeFileSync(
    join(dir, 'ct', cassetteFile('GET', url, null)),
    JSON.stringify({
      recordedAt: identity.capturedAt,
      request: { method: 'GET', url, headers: {}, body: null },
      response: {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entries),
      },
    }),
  );
  return dir;
}

const entry = (names: string[], issuer = "C=US, O=Let's Encrypt, CN=R11") => ({
  name_value: names.join('\n'),
  not_before: '2026-01-01T00:00:00',
  not_after: '2026-04-01T00:00:00',
  issuer_name: issuer,
});

describe('classifying what a name suggests', () => {
  it('reads the label, not the whole host, and never the domain itself', () => {
    const d = 'eksempelbutik.dk';
    expect(classifyHost('eksempelbutik.dk', d)).toBe('production');
    expect(classifyHost('www.eksempelbutik.dk', d)).toBe('production');
    expect(classifyHost('staging.eksempelbutik.dk', d)).toBe('non_production');
    expect(classifyHost('dev2.eksempelbutik.dk', d)).toBe('non_production');
    expect(classifyHost('test-api.eksempelbutik.dk', d)).toBe('non_production');
    expect(classifyHost('admin.eksempelbutik.dk', d)).toBe('internal_service');
    expect(classifyHost('webmail.eksempelbutik.dk', d)).toBe('internal_service');
    expect(classifyHost('api.eksempelbutik.dk', d)).toBe('api');
    expect(classifyHost('cdn.eksempelbutik.dk', d)).toBe('static');
    expect(classifyHost('shop.eksempelbutik.dk', d)).toBe('commerce');
    expect(classifyHost('*.eksempelbutik.dk', d)).toBe('wildcard');
    expect(classifyHost('blog.eksempelbutik.dk', d)).toBe('other');
    // "administration.example" is not "admin.": the label has to be the whole word.
    expect(classifyHost('administration.eksempelbutik.dk', d)).toBe('other');
  });
});

describe('reading the log', () => {
  it('folds duplicates, keeps issuers and dates, drops names outside the domain, sorts', () => {
    const hosts = hostsFromEntries(
      [
        entry(['www.eksempelbutik.dk', 'eksempelbutik.dk']),
        entry(['staging.eksempelbutik.dk'], 'C=US, O=DigiCert Inc'),
        entry(['staging.eksempelbutik.dk'], "C=US, O=Let's Encrypt, CN=R11"),
        entry(['*.eksempelbutik.dk']),
        entry(['eksempelbutik.dk.evil.example', 'notmine.dk']),
        { name_value: undefined } as unknown as Parameters<typeof hostsFromEntries>[0][number],
      ],
      'eksempelbutik.dk',
    );
    expect(hosts.map((h) => [h.host, h.class, h.certificates])).toEqual([
      ['*.eksempelbutik.dk', 'wildcard', 1],
      ['eksempelbutik.dk', 'production', 1],
      ['staging.eksempelbutik.dk', 'non_production', 2],
      ['www.eksempelbutik.dk', 'production', 1],
    ]);
    expect(hosts[2]?.issuers).toEqual(['C=US, O=DigiCert Inc', "C=US, O=Let's Encrypt, CN=R11"]);
    expect(hosts[2]).toMatchObject({
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-04-01T00:00:00.000Z',
    });
  });
});

describe('enumerating through the mirror', () => {
  it('caps the list, reports exposure as names in a public log, and points at the evidence', async () => {
    const many = Array.from({ length: DEFAULT_HOST_CAP + 20 }, (_, i) =>
      entry([`host${String(i).padStart(3, '0')}.big.dk`]),
    );
    const dir = cassetteFor('big.dk', [
      ...many,
      entry(['staging.big.dk']),
      entry(['admin.big.dk']),
      entry(['www.big.dk']),
    ]);
    const fetch = createRecordedFetch(config, { name: 'ct', dir });
    const { enumeration, evidence } = await enumerateCertificates(fetch, 'big.dk', {
      identity,
      hostCap: DEFAULT_HOST_CAP,
    });
    expect(CtEnumerationSchema.parse(enumeration)).toEqual(enumeration);
    expect(enumeration.entries).toBe(DEFAULT_HOST_CAP + 23);
    expect(enumeration.hosts.length).toBe(DEFAULT_HOST_CAP);
    expect(enumeration.capped).toBe(true);
    expect(enumeration.probed).toBe(0);
    expect(enumeration.observation).toMatchObject({ findingTypeId: 'EXP-01', outcome: 'fail' });
    expect(enumeration.observation.summary).toMatch(/admin\.big\.dk/);
    expect(enumeration.observation.summary).toMatch(/not a breach/);
    expect(enumeration.observation.summary).not.toMatch(/breached|compromised|hacked/);
    expect(enumeration.observation.evidence[0]?.hash).toBe(evidence[0]?.hash);
    expect(evidence[0]?.source).toMatchObject({
      registry: 'certificate-transparency',
      host: 'big.dk',
    });
  });

  it('a domain with only production names passes; an empty or broken answer is not a finding', async () => {
    const clean = createRecordedFetch(config, {
      name: 'ct',
      dir: cassetteFor('clean.dk', [entry(['clean.dk', 'www.clean.dk', 'shop.clean.dk'])]),
    });
    const { enumeration } = await enumerateCertificates(clean, 'clean.dk', { identity });
    expect(enumeration.observation).toMatchObject({ outcome: 'pass' });
    expect(enumeration.observation.summary).toBe(
      '3 host(s) named under clean.dk; none looks like a non-production or internal service.',
    );

    const empty = createRecordedFetch(config, { name: 'ct', dir: cassetteFor('none.dk', []) });
    const nothing = await enumerateCertificates(empty, 'none.dk', { identity });
    expect(nothing.enumeration).toMatchObject({
      hosts: [],
      capped: false,
      observation: { outcome: 'pass' },
    });
  });

  it('without a cassette, replay mode refuses rather than calls out', async () => {
    const fetch = createRecordedFetch(config, {
      name: 'ct',
      dir: mkdtempSync(join(tmpdir(), 'ct-empty-')),
    });
    await expect(enumerateCertificates(fetch, 'unrecorded.dk', { identity })).rejects.toThrow(
      /no cassette/,
    );
  });

  it('the finding has a remedy in every supported jurisdiction, and never calls a vendor unlawful', () => {
    const catalogue = loadCatalogue();
    for (const j of ['DK', 'DE'])
      expect(catalogue.forFinding('EXP-01', j).length, j).toBeGreaterThan(0);
    const text = JSON.stringify(catalogue.get('exp-01-review-named-hosts')?.remedy);
    expect(text).not.toMatch(/unlawful|illegal|breach/i);
  });
});
