import { describe, expect, it } from 'vitest';
import { DnsCollectionSchema, DnsServiceMapSchema, VendorSchema } from '@gc/contracts';
import {
  DNS_FIXTURES_DIR,
  DnsRecordingMissingError,
  candidateProcessors,
  collectDns,
  isVerificationToken,
  loadDnsServiceMap,
  matchService,
  parseSpf,
  recordedResolver,
} from '@gc/scanner';

// DNS collection without a network (D-01): the map is curated and provenance-tracked,
// the parsers read what a record says, unknowns stay unknown with their raw value, and
// every mapped service becomes a candidate processor the vendor contract accepts.

const identity = {
  tenantId: 't-1',
  caseId: 'DK-26-0M4K',
  scanId: 'scan-1',
  capturedAt: '2026-09-04T09:14:00Z',
};

describe('the token-to-service map', () => {
  const map = loadDnsServiceMap();

  it('is versioned, unique by id, and every entry names where its pattern was read', () => {
    expect(map.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(DnsServiceMapSchema.safeParse(map).success).toBe(true);
    expect(new Set(map.services.map((s) => s.id)).size).toBe(map.services.length);
    for (const s of map.services) {
      expect(s.provenance.url, s.id).toMatch(/^https:\/\//);
      expect(s.provenance.verifiedAt, s.id).toMatch(/^\d{4}-/);
      expect(
        s.txtPrefixes.length + s.spfIncludes.length + s.mxSuffixes.length + s.cnameSuffixes.length,
        s.id,
      ).toBeGreaterThan(0);
    }
    expect(map.services.length).toBeGreaterThanOrEqual(10);
  });

  it('refuses an entry that matches on nothing, or a duplicate id', () => {
    const base = map.services[0]!;
    expect(
      DnsServiceMapSchema.safeParse({
        version: '2026-09-04',
        services: [
          { ...base, txtPrefixes: [], spfIncludes: [], mxSuffixes: [], cnameSuffixes: [] },
        ],
      }).success,
    ).toBe(false);
    expect(
      DnsServiceMapSchema.safeParse({ version: '2026-09-04', services: [base, base] }).success,
    ).toBe(false);
    expect(DnsServiceMapSchema.safeParse({ version: 'v3', services: [base] }).success).toBe(false);
  });

  it('matches by prefix, include, exchange suffix and cname suffix, and only those', () => {
    expect(matchService(map, 'txt', 'google-site-verification=xyz')?.service.id).toBe(
      'google-workspace',
    );
    expect(matchService(map, 'txt', 'GOOGLE-SITE-VERIFICATION=xyz')?.matchedBy).toBe('txt_prefix');
    expect(matchService(map, 'spf_include', '_spf.google.com')?.service.id).toBe(
      'google-workspace',
    );
    expect(matchService(map, 'spf_include', 'eu.mailgun.org')?.service.id).toBe('mailgun');
    expect(matchService(map, 'mx', 'alt1.aspmx.l.google.com.')?.matchedBy).toBe('mx_suffix');
    expect(
      matchService(map, 'mx', 'eksempelbutik-dk.mail.protection.outlook.com')?.service.id,
    ).toBe('microsoft-365');
    expect(matchService(map, 'cname', 'u1.wl.sendgrid.net')?.service.id).toBe('sendgrid');
    expect(matchService(map, 'mx', 'notgoogle.com')).toBeUndefined();
    expect(matchService(map, 'mx', 'google.com.evil.example')).toBeUndefined();
    expect(matchService(map, 'txt', 'unknownco-verification=1')).toBeUndefined();
  });
});

describe('parsing', () => {
  it('reads SPF terms and the all qualifier; anything that is not SPF is not SPF', () => {
    expect(parseSpf('v=spf1 include:_spf.google.com ip4:1.2.3.0/24 a mx ~all')).toEqual({
      raw: 'v=spf1 include:_spf.google.com ip4:1.2.3.0/24 a mx ~all',
      includes: ['_spf.google.com'],
      mechanisms: ['ip4:1.2.3.0/24', 'a', 'mx'],
      all: '~all',
    });
    expect(parseSpf('v=spf1 -all')?.includes).toEqual([]);
    expect(parseSpf('v=spf10 include:x')).toBeUndefined();
    expect(parseSpf('google-site-verification=x')).toBeUndefined();
  });

  it('tells a verification token from prose and from mail policy records', () => {
    expect(isVerificationToken('google-site-verification=abc')).toBe(true);
    expect(isVerificationToken('MS=ms123')).toBe(true);
    expect(isVerificationToken('brevo-code: abc')).toBe(true);
    expect(isVerificationToken('v=spf1 -all')).toBe(false);
    expect(isVerificationToken('v=DMARC1; p=none')).toBe(false);
    expect(isVerificationToken('Some plain text a registrar left here')).toBe(false);
  });
});

describe('collecting from a recording', () => {
  it('maps what the map knows, reports the rest as unknown with the raw value, and keeps the evidence', async () => {
    const resolver = recordedResolver('eksempelbutik.test');
    const { collection, evidence } = await collectDns(resolver, 'eksempelbutik.test', { identity });
    expect(DnsCollectionSchema.parse(collection)).toEqual(collection);
    expect(collection.mapVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(collection.spf?.includes).toEqual([
      '_spf.google.com',
      'spf.protection.outlook.com',
      'sendgrid.net',
      'spf.unknownco.example',
    ]);
    expect(collection.spf?.all).toBe('-all');
    expect(collection.dmarc).toMatch(/^v=DMARC1/);

    expect(collection.services.map((s) => [s.serviceId, s.matchedBy, s.raw]).sort()).toEqual(
      [
        ['google-workspace', 'spf_include', '_spf.google.com'],
        ['google-workspace', 'txt_prefix', 'google-site-verification=abc123def456ghi789'],
        ['google-workspace', 'mx_suffix', 'aspmx.l.google.com'],
        ['google-workspace', 'mx_suffix', 'alt1.aspmx.l.google.com'],
        ['microsoft-365', 'spf_include', 'spf.protection.outlook.com'],
        ['microsoft-365', 'txt_prefix', 'MS=ms12345678'],
        ['sendgrid', 'spf_include', 'sendgrid.net'],
        ['sendgrid', 'cname_suffix', 'u1234567.wl123.sendgrid.net'],
        ['meta-business', 'txt_prefix', 'facebook-domain-verification=zzz999'],
      ].sort(),
    );
    expect(collection.unknown.map((u) => [u.kind, u.raw])).toEqual([
      ['spf_include', 'spf.unknownco.example'],
      ['verification_token', 'unknownco-verification=0123456789'],
      ['mx_exchange', 'mx.unknownco.example'],
      ['cname_target', 'ghs.googlehosted.com'],
    ]);
    // Prose is neither a service nor an unknown token; it is just a record.
    expect(collection.records.some((r) => r.value.startsWith('Some plain text'))).toBe(true);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      kind: 'registry_record',
      source: { registry: 'dns', host: 'eksempelbutik.test' },
    });
    expect(collection.evidence[0]?.hash).toBe(evidence[0]?.hash);
  });

  it('every mapped service becomes one unresolved level-1 candidate with the records as evidence', async () => {
    const { collection } = await collectDns(
      recordedResolver('eksempelbutik.test'),
      'eksempelbutik.test',
      { identity },
    );
    const vendors = candidateProcessors(collection, identity);
    expect(vendors.map((v) => v.id).sort()).toEqual([
      'vendor:dns:google-workspace:eksempelbutik.test',
      'vendor:dns:meta-business:eksempelbutik.test',
      'vendor:dns:microsoft-365:eksempelbutik.test',
      'vendor:dns:sendgrid:eksempelbutik.test',
    ]);
    for (const v of vendors) {
      expect(VendorSchema.parse(v)).toEqual(v);
      expect(v).toMatchObject({
        level: 1,
        resolution: 'unresolved',
        provenance: { source: 'observation', evidence: collection.evidence },
      });
      expect(v.provenance.registryVersion).toMatch(/^dns-services@\d{4}-\d{2}-\d{2}$/);
      expect(v.legalEntity).toBeUndefined();
    }
    const google = vendors.find((v) => v.id.includes('google-workspace'))!;
    expect(google.hosts.sort()).toEqual(['alt1.aspmx.l.google.com', 'aspmx.l.google.com']);
    expect(google).toMatchObject({
      label: 'Google Workspace',
      jurisdiction: 'US',
      role: 'processor',
    });
    expect(vendors.find((v) => v.id.includes('meta-business'))?.role).toBe(
      'independent_controller',
    );
  });

  it('a domain without a recording is an error in replay mode, not a lookup', () => {
    expect(() => recordedResolver('nothing-recorded.test')).toThrow(DnsRecordingMissingError);
    expect(() => recordedResolver('nothing-recorded.test')).toThrow(/GC_NETWORK=record/);
    expect(DNS_FIXTURES_DIR).toMatch(/fixtures[\\/]dns/);
  });
});
