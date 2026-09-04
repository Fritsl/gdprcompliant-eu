import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@gc/config';
import {
  createTestDatabase,
  openCase,
  schema,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import {
  DnsRecordingMissingError,
  candidateProcessors,
  collectDns,
  createResolver,
} from '@gc/scanner';

// DNS collection end to end (D-01): the resolver the config's network mode calls for,
// the recorded domain collected, and every mapped service landing on the case graph as
// a vendor row under the case's tenant.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const baseEnv = {
  DATABASE_URL: 'postgres://gc:gc@localhost:5432/gdprcompliant',
  MODEL_BASE_URL: 'http://localhost:8000/v1',
  MODEL_API_KEY: 'x',
  MODEL_CHAT: 'chat-model',
  MODEL_EMBEDDING: 'embedding-model',
  APP_BASE_URL: 'https://gdprcompliant.eu',
};

describe('the resolver follows the network mode (D-01)', () => {
  it('replay by default: a recorded domain answers, an unrecorded one is an error, never a lookup', async () => {
    const config = loadConfig({ ...baseEnv, GC_NETWORK: 'replay' });
    const resolver = createResolver(config, 'eksempelbutik.test');
    expect(await resolver.mx('eksempelbutik.test')).toHaveLength(3);
    expect(() => createResolver(config, 'never-recorded.test')).toThrow(DnsRecordingMissingError);
  });
});

describe.skipIf(!url)(
  'collected services become candidate processors on the case graph (D-01)',
  () => {
    let t: TestDatabase;

    beforeAll(async () => {
      t = await createTestDatabase(url);
    });

    afterAll(async () => {
      await t?.drop();
    });

    it('inserts one unresolved vendor per mapped service, with the DNS evidence, under the tenant', async () => {
      const opened = await openCase(t, {
        company: { domain: 'eksempelbutik.test', country: 'DK', locale: 'da' },
        jurisdiction: 'DK',
        locale: 'da',
      });
      const identity = {
        tenantId: opened.tenantId,
        caseId: opened.caseId,
        scanId: 'scan-1',
        capturedAt: '2026-09-04T09:14:00Z',
      };
      const config = loadConfig({ ...baseEnv, GC_NETWORK: 'replay' });
      const { collection, evidence } = await collectDns(
        createResolver(config, 'eksempelbutik.test'),
        'eksempelbutik.test',
        { identity },
      );
      const vendors = candidateProcessors(collection, identity);
      expect(vendors.length).toBe(4);

      await withTenant(t, opened.tenantId, async (db) => {
        for (const e of evidence) {
          await db.insert(schema.evidence).values({
            id: e.id,
            tenantId: e.tenantId,
            sourceRef: 'dns',
            caseId: e.caseId,
            scanId: e.scanId ?? null,
            kind: e.kind,
            capturedAt: new Date(e.capturedAt),
            observed: e.source,
            body: e.body,
            hash: e.hash,
            caption: e.caption ?? null,
          });
        }
        for (const v of vendors) {
          await db.insert(schema.vendors).values({
            id: v.id,
            tenantId: v.tenantId,
            sourceRef: 'dns',
            caseId: v.caseId,
            label: v.label,
            legalEntity: v.legalEntity ?? null,
            jurisdiction: v.jurisdiction,
            parentJurisdiction: v.parentJurisdiction ?? null,
            role: v.role,
            level: v.level,
            parentVendorId: v.parentVendorId ?? null,
            hosts: v.hosts,
            resolution: v.resolution,
            provenance: v.provenance,
            transfer: v.transfer ?? null,
          });
        }
      });

      const rows = await withTenant(t, opened.tenantId, (db) => db.select().from(schema.vendors));
      expect(rows.map((r) => r.label).sort()).toEqual([
        'Google Workspace',
        'Meta Business (domain verification)',
        'Microsoft 365',
        'SendGrid (Twilio)',
      ]);
      // All four are behind vendor registry entries (S-07): resolved, with the entity stored.
      expect(rows.every((r) => r.resolution === 'resolved' && r.level === 1)).toBe(true);
      expect(rows.every((r) => (r.legalEntity as { name?: string } | null)?.name)).toBe(true);
      const stored = await withTenant(t, opened.tenantId, (db) =>
        db.select().from(schema.evidence),
      );
      expect(stored[0]?.hash).toBe(collection.evidence[0]?.hash);
    });
  },
);
