import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openEvidencePack } from '@gc/artefacts';
import { sha256 } from '@gc/contracts';
import {
  SHARED_TENANT,
  appendCaseEvent,
  caseTimeline,
  confirmClaim,
  createTestDatabase,
  evidencePack,
  openCase,
  recordPackGenerated,
  requestClaim,
  schema,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';

// The evidence pack (G-04): everything a reader needs to see that the work happened,
// as plain files anyone can open; the same case at the same point packs to the same
// bytes; and a change to the case changes the pack.

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

const T0 = new Date('2026-09-04T09:14:00Z');
const AT = new Date('2026-09-05T08:00:00Z');
const dec = new TextDecoder();

describe.skipIf(!url)('the evidence pack (G-04)', () => {
  let t: TestDatabase;
  let caseId = '';
  let tenantId = '';

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => T0,
    });
    caseId = opened.caseId;
    tenantId = opened.tenantId;
    await t.db.insert(schema.remedies).values({
      id: 'sec-03-hsts',
      version: 1,
      tenantId: SHARED_TENANT,
      sourceRef: 'catalogue',
      findingTypeId: 'SEC-03',
      kind: 'self_fix',
      jurisdictions: 'all',
      content: {},
      hash: sha256('sec-03'),
    });
    const body = 'header: strict-transport-security missing';
    const hash = sha256(body);
    await withTenant(t, tenantId, async (db) => {
      await db.insert(schema.evidence).values({
        id: `header:${hash.slice(0, 16)}`,
        tenantId,
        sourceRef: 'test',
        caseId,
        kind: 'header',
        capturedAt: T0,
        body,
        hash,
        caption: 'GET https://eksempelbutik.dk/',
      });
      await db.insert(schema.findings).values({
        id: 'f-sec',
        tenantId,
        sourceRef: 'test',
        caseId,
        typeId: 'SEC-03',
        fingerprint: 'SEC-03|eksempelbutik.dk',
        jurisdiction: 'DK',
        binding: { findingTypeId: 'SEC-03', jurisdiction: 'DK', version: 3, guideId: 'hsts' },
        severity: 'serious',
        status: 'closed',
        closedAt: T0,
        area: 'Security',
        remedyId: 'sec-03-hsts',
        remedyVersion: 1,
        firstSeenAt: T0,
        lastSeenAt: T0,
      });
      await db.insert(schema.findingEvidence).values({
        findingId: 'f-sec',
        evidenceId: `header:${hash.slice(0, 16)}`,
        tenantId,
        sourceRef: 'test',
      });
      await db.insert(schema.vendors).values({
        id: 'vendor:dns:google-workspace:eksempelbutik.dk',
        tenantId,
        sourceRef: 'dns',
        caseId,
        label: 'Google Workspace',
        jurisdiction: 'US',
        role: 'processor',
        resolution: 'unresolved',
        provenance: {
          source: 'observation',
          registryVersion: 'dns-services@2026-09-04',
          seenAt: T0.toISOString(),
          evidence: [],
        },
      });
      await appendCaseEvent(db, {
        tenantId,
        caseId,
        at: new Date(T0.getTime() + 60_000),
        actor: { kind: 'person', userId: 'u1', name: 'Mette' },
        type: 'finding_closed',
        payload: { findingId: 'f-sec', verifiedBy: 'rescan' },
      });
    });
    const challenge = await requestClaim(t, {
      caseId,
      tenantId,
      email: 'mette@eksempelbutik.dk',
      now: () => T0,
    });
    await confirmClaim(t, {
      caseId,
      tenantId,
      code: challenge.code,
      now: () => new Date(T0.getTime() + 120_000),
    });
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('holds the timeline, the findings, the evidence, the sign-offs and the corpus versions, in plain files', async () => {
    const pack = await evidencePack(t, tenantId, caseId, { locale: 'en', at: AT });
    const files = openEvidencePack(pack.zip);
    expect(Object.keys(files).sort()).toEqual([
      'MANIFEST.json',
      'README.md',
      'case.json',
      'evidence/header_' +
        sha256('header: strict-transport-security missing').slice(0, 16) +
        '.json',
      'timeline.pdf',
    ]);
    const readme = dec.decode(files['README.md']!);
    expect(readme).toContain(`# Evidence pack · ${caseId}`);
    expect(readme).toContain('Generated 2026-09-05T08:00:00.000Z for eksempelbutik.dk');
    expect(readme).toContain('mette@eksempelbutik.dk · took ownership of the case (email)');
    expect(readme).toContain('Mette · closed f-sec, verified by rescan');
    expect(readme).toContain('binding SEC-03/DK: 3');
    expect(readme).toContain('registry dns-services: 2026-09-04');
    expect(readme).toMatch(/remedy-catalogue-lock: [a-f0-9]{64}/);
    expect(readme).toContain('- findings: 1');
    expect(readme).not.toMatch(/certif(ied|ication)|compliant|approved/i);

    const bundle = JSON.parse(dec.decode(files['case.json']!)) as Record<string, unknown[]> & {
      case: Record<string, unknown>;
    };
    expect(bundle['format']).toBe('gdprcompliant.eu/evidence-pack');
    expect(bundle['findings']).toHaveLength(1);
    expect(bundle['evidence']).toHaveLength(1);
    expect((bundle['timeline'] as { type: string }[]).map((e) => e.type)).toEqual([
      'case_opened',
      'finding_closed',
      'claim_requested',
      'case_claimed',
    ]);
    expect(bundle['signoffs']).toHaveLength(2);
    expect(bundle.case).not.toHaveProperty('accessToken');

    const evidenceFile = JSON.parse(
      dec.decode(files[Object.keys(files).find((n) => n.startsWith('evidence/'))!]!),
    ) as { body: string; hash: string };
    expect(sha256(evidenceFile.body)).toBe(evidenceFile.hash);
    expect(dec.decode(files['timeline.pdf']!.subarray(0, 5))).toBe('%PDF-');

    const manifest = JSON.parse(dec.decode(files['MANIFEST.json']!)) as {
      files: { name: string; sha256: string }[];
    };
    for (const m of manifest.files) {
      expect(sha256(Buffer.from(files[m.name]!)), m.name).toBe(m.sha256);
    }
  });

  it('is reproducible: the same case at the same point packs to the same bytes, and a change changes it', async () => {
    const a = await evidencePack(t, tenantId, caseId, { locale: 'en', at: AT });
    const b = await evidencePack(t, tenantId, caseId, { locale: 'en', at: AT });
    expect(b.sha256).toBe(a.sha256);
    expect(Buffer.from(b.zip).equals(Buffer.from(a.zip))).toBe(true);
    // Building a pack wrote nothing.
    const before = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    expect(before).toHaveLength(4);

    await recordPackGenerated(t, tenantId, caseId, a, AT);
    const after = await withTenant(t, tenantId, (db) => caseTimeline(db, caseId));
    expect(after.at(-1)).toMatchObject({
      type: 'artefact_generated',
      payload: { kind: 'evidence_pack' },
    });
    const c = await evidencePack(t, tenantId, caseId, { locale: 'en', at: AT });
    expect(c.sha256).not.toBe(a.sha256);
    const later = await evidencePack(t, tenantId, caseId, {
      locale: 'en',
      at: new Date(AT.getTime() + 1000),
    });
    expect(later.sha256).not.toBe(c.sha256);
  });
});
