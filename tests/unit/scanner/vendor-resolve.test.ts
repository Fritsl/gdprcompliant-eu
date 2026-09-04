import { describe, expect, it } from 'vitest';
import { VendorRegistrySchema, VendorSchema, inEea } from '@gc/contracts';
import {
  auditRegistry,
  candidateProcessors,
  collectDns,
  entityFields,
  loadVendorRegistry,
  recordedResolver,
  resolveHost,
  resolveHosts,
  staleEntries,
  vendorForDnsService,
  vendorMaps,
} from '@gc/scanner';

// Host to legal entity (S-07): the registry is curated data with provenance and a review
// date on every entry; it names the contracting entity and the ultimate parent apart;
// a host it does not cover comes back unresolved with the host on it; the three maps
// agree; and a DNS service becomes a resolved vendor row with its legal entity.

const maps = vendorMaps();
const registry = loadVendorRegistry();

describe('the vendor registry', () => {
  it('is versioned, unique by id, and every entry carries its source and its review date', () => {
    expect(registry.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(VendorRegistrySchema.safeParse(registry).success).toBe(true);
    expect(new Set(registry.vendors.map((v) => v.id)).size).toBe(registry.vendors.length);
    expect(registry.vendors.length).toBeGreaterThanOrEqual(12);
    for (const v of registry.vendors) {
      expect(v.provenance.url, v.id).toMatch(/^https:\/\//);
      expect(v.provenance.verifiedAt, v.id).toMatch(/^\d{4}-/);
      expect(v.reviewBy, v.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(v.reviewBy).getTime()).toBeGreaterThan(
        new Date(v.provenance.verifiedAt).getTime(),
      );
      expect(
        v.hostSuffixes.length + v.dnsServices.length + v.recipientHosts.length,
        v.id,
      ).toBeGreaterThan(0);
    }
  });

  it('names the contracting entity and the ultimate parent apart', () => {
    const google = registry.vendors.find((v) => v.id === 'google')!;
    expect(google.contracting).toMatchObject({ name: 'Google Ireland Limited', country: 'IE' });
    expect(google.parent).toMatchObject({ name: 'Alphabet Inc.', country: 'US' });
    // The transfer question arises when either sits outside the EEA.
    expect(entityFields(google)).toMatchObject({
      legalEntity: { name: 'Google Ireland Limited', registryId: '368047' },
      jurisdiction: 'IE',
      parentJurisdiction: 'US',
      transfer: { outsideEea: true, mechanism: 'unknown' },
      resolution: 'resolved',
    });
    // Both inside the EEA: no transfer question, and no parent jurisdiction to show
    // when it is the same country.
    const cookiebot = registry.vendors.find((v) => v.id === 'cookiebot')!;
    expect(entityFields(cookiebot)).toMatchObject({
      jurisdiction: 'DK',
      parentJurisdiction: 'DE',
      transfer: { outsideEea: false },
    });
    const usercentrics = registry.vendors.find((v) => v.id === 'usercentrics')!;
    expect(entityFields(usercentrics)).not.toHaveProperty('parentJurisdiction');
    expect(inEea('IE') && inEea('DK') && !inEea('US')).toBe(true);
  });

  it('the three maps agree: every link resolves, nothing is claimed twice, and the gaps are named', () => {
    const audit = auditRegistry(maps);
    expect(audit.problems).toEqual([]);
    // What the registry does not yet cover is reported, never hidden.
    for (const u of audit.unclaimed) expect(['dns_service', 'recipient_host']).toContain(u.kind);
    expect(audit.unclaimed.map((u) => u.id)).not.toContain('google');
    expect(audit.unclaimed.map((u) => u.id)).not.toContain('google-workspace');
  });

  it('a stale entry is one past its review date or read too long ago, and today none is', () => {
    expect(staleEntries(registry, new Date('2026-09-04T12:00:00Z'))).toEqual([]);
    const later = staleEntries(registry, new Date('2027-12-01T00:00:00Z'));
    expect(
      later
        .filter((s) => s.reason === 'review_due')
        .map((s) => s.id)
        .sort(),
    ).toEqual(registry.vendors.map((v) => v.id).sort());
    expect(later.some((s) => s.reason === 'verified_long_ago')).toBe(true);
    expect(
      staleEntries(registry, new Date('2026-12-01T00:00:00Z'), { maxAgeDays: 30 }).every(
        (s) => s.reason === 'verified_long_ago',
      ),
    ).toBe(true);
  });
});

describe('resolving a host', () => {
  it('finds the entity behind a request host through the recipient map, longest suffix first', () => {
    const r = resolveHost('www.googletagmanager.com', maps);
    expect(r.resolution).toBe('resolved');
    if (r.resolution === 'resolved') {
      expect(r.entry.id).toBe('google');
      expect(r.suffix).toBe('googletagmanager.com');
    }
    expect(resolveHost('FONTS.GSTATIC.COM.', maps)).toMatchObject({
      resolution: 'resolved',
      entry: { id: 'google' },
    });
    expect(resolveHost('connect.facebook.net', maps)).toMatchObject({
      resolution: 'resolved',
      entry: { id: 'meta' },
    });
  });

  it('finds the entity behind a mail host through the DNS map', () => {
    expect(resolveHost('aspmx.l.google.com', maps)).toMatchObject({
      resolution: 'resolved',
      entry: { id: 'google' },
    });
    expect(resolveHost('eksempelbutik-dk.mail.protection.outlook.com', maps)).toMatchObject({
      resolution: 'resolved',
      entry: { id: 'microsoft' },
    });
  });

  it('a host nothing covers is unresolved with the host on it, and every host comes back', () => {
    const results = resolveHosts(
      ['cdn.ukendt-leverandoer.test', 'www.googletagmanager.com', 'notgoogle.com'],
      maps,
    );
    expect(results.map((r) => [r.host, r.resolution])).toEqual([
      ['cdn.ukendt-leverandoer.test', 'unresolved'],
      ['www.googletagmanager.com', 'resolved'],
      ['notgoogle.com', 'unresolved'],
    ]);
  });

  it('two entries on the same suffix are ambiguous, never a silent pick', () => {
    const twin = {
      ...maps,
      registry: {
        ...maps.registry,
        vendors: [
          ...maps.registry.vendors,
          {
            ...maps.registry.vendors.find((v) => v.id === 'meta')!,
            id: 'meta-twin',
            recipientHosts: [],
            dnsServices: [],
            hostSuffixes: ['facebook.net'],
          },
        ],
      },
    };
    const r = resolveHost('connect.facebook.net', twin);
    expect(r.resolution).toBe('ambiguous');
    if (r.resolution === 'ambiguous')
      expect(r.entries.map((e) => e.id).sort()).toEqual(['meta', 'meta-twin']);
  });
});

describe('a DNS service becomes a vendor row with its legal entity', () => {
  const identity = {
    tenantId: 't-1',
    caseId: 'DK-26-0M4K',
    scanId: 'scan-1',
    capturedAt: '2026-09-04T09:14:00Z',
  };

  it('resolved through the registry where it is covered, unresolved with the raw service where not', async () => {
    const { collection } = await collectDns(
      recordedResolver('eksempelbutik.test'),
      'eksempelbutik.test',
      { identity },
    );
    const vendors = candidateProcessors(collection, identity);
    expect(vendors.length).toBeGreaterThan(0);
    for (const v of vendors) expect(VendorSchema.safeParse(v).success, v.id).toBe(true);
    const google = vendors.find((v) => v.id.includes(':google-workspace:'));
    expect(google).toBeDefined();
    expect(google).toMatchObject({
      resolution: 'resolved',
      legalEntity: { name: 'Google Ireland Limited' },
      jurisdiction: 'IE',
      parentJurisdiction: 'US',
      transfer: { outsideEea: true },
    });
    expect(google!.provenance.registryVersion).toContain(`vendors@${registry.version}`);
    expect(vendorForDnsService('google-workspace', maps)?.id).toBe('google');
    // A service the registry does not cover keeps the map's word and stays unresolved.
    const uncovered = collection.services.find((s) => !vendorForDnsService(s.serviceId, maps));
    if (uncovered) {
      const row = vendors.find((v) => v.id.includes(`:${uncovered.serviceId}:`))!;
      expect(row.resolution).toBe('unresolved');
      expect(row).not.toHaveProperty('legalEntity');
      expect(row.label).toBe(uncovered.name);
    }
  });
});
