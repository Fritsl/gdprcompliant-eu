import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@gc/contracts';
import { openEvidencePack } from '@gc/artefacts';
import {
  SignatureRequired,
  StaleSignature,
  artefactsForCase,
  caseTimeline,
  createTestDatabase,
  evidencePack,
  exportArtefact,
  generateArtefact,
  openCase,
  publishArtefact,
  signArtefact,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';

// The human sign-off gate (A-09): a generated document cannot be published or exported
// until a named person has signed the version and the bytes they saw; the signature
// records who, when and which version; it shows on the timeline and in the evidence
// pack; regenerating the document clears it; an agent cannot sign.

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
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const mette = { kind: 'person' as const, userId: 'u-mette', name: 'Mette Hansen' };
const agent = { kind: 'agent' as const, name: 'drafter' };
let db: TestDatabase;
let tenantId: string;
let caseId: string;

beforeAll(async () => {
  if (!url) return;
  db = await createTestDatabase(url);
  const opened = await openCase(db, {
    company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
    jurisdiction: 'DK',
    locale: 'da',
    now: () => T0,
  });
  tenantId = opened.tenantId;
  caseId = opened.caseId;
});

afterAll(async () => {
  await db?.drop();
});

describe.skipIf(!url)('nothing leaves without a name under it', () => {
  it('a fresh document is a draft: publish and export are refused, and the refusal says why', async () => {
    const generated = await generateArtefact(db, tenantId, {
      caseId,
      kind: 'privacy_policy',
      locale: 'da',
      content: 'Privatlivspolitik v1',
      by: agent,
      now: at(1),
    });
    expect(generated).toEqual({
      id: generated.id,
      kind: 'privacy_policy',
      version: 1,
      hash: sha256('Privatlivspolitik v1'),
    });
    await expect(
      publishArtefact(db, tenantId, generated.id, { by: mette, now: at(2) }),
    ).rejects.toThrow(SignatureRequired);
    await expect(
      publishArtefact(db, tenantId, generated.id, { by: mette, now: at(2) }),
    ).rejects.toThrow(/privacy_policy v1 has not been signed off/);
    await expect(exportArtefact(db, tenantId, generated.id)).rejects.toThrow(SignatureRequired);
  });

  it('an agent cannot sign; a person must sign the version and the bytes they saw', async () => {
    const [row] = await artefactsForCase(db, tenantId, caseId);
    const id = row!.id;
    await expect(
      signArtefact(db, tenantId, id, { by: agent, version: 1, hash: row!.hash, now: at(3) }),
    ).rejects.toThrow(/a sign-off is a person's, not a agent's/);
    await expect(
      signArtefact(db, tenantId, id, { by: mette, version: 2, hash: row!.hash, now: at(3) }),
    ).rejects.toThrow(StaleSignature);
    await expect(
      signArtefact(db, tenantId, id, { by: mette, version: 1, hash: 'a'.repeat(64), now: at(3) }),
    ).rejects.toThrow(/the signed bytes are not the document’s bytes/);
    const signed = await signArtefact(db, tenantId, id, {
      by: mette,
      version: 1,
      hash: row!.hash,
      now: at(4),
    });
    expect(signed).toEqual({
      version: 1,
      hash: row!.hash,
      by: { userId: 'u-mette', name: 'Mette Hansen' },
    });
  });

  it('a signed document can be exported and published, and the signature travels with it', async () => {
    const [row] = await artefactsForCase(db, tenantId, caseId);
    const exported = await exportArtefact(db, tenantId, row!.id);
    expect(exported).toMatchObject({
      kind: 'privacy_policy',
      version: 1,
      content: 'Privatlivspolitik v1',
      signedBy: { userId: 'u-mette', name: 'Mette Hansen' },
      signedAt: at(4).toISOString(),
    });
    const published = await publishArtefact(db, tenantId, row!.id, {
      by: mette,
      url: 'https://eksempelbutik.dk/privatlivspolitik',
      now: at(5),
    });
    expect(published).toEqual({ version: 1, hash: row!.hash });
    const [after] = await artefactsForCase(db, tenantId, caseId);
    expect(after!.status).toBe('published');
  });

  it('the timeline and the evidence pack carry who signed what, when, and which version', async () => {
    const timeline = await withTenant(db, tenantId, (tx) => caseTimeline(tx, caseId));
    const signed = timeline.find((e) => e.type === 'artefact_signed')!;
    expect(signed.actor).toEqual(mette);
    expect(signed.at).toBe(at(4).toISOString());
    expect(signed.payload).toMatchObject({
      kind: 'privacy_policy',
      version: 1,
      by: 'Mette Hansen',
      hash: sha256('Privatlivspolitik v1'),
    });
    const published = timeline.find((e) => e.type === 'artefact_published')!;
    expect(published.payload).toEqual({
      artefactId: signed.payload.artefactId,
      kind: 'privacy_policy',
      url: 'https://eksempelbutik.dk/privatlivspolitik',
    });

    const pack = await evidencePack(db, tenantId, caseId, { locale: 'en', at: at(6) });
    const files = openEvidencePack(pack.zip);
    const readme = new TextDecoder().decode(files['README.md']!);
    expect(readme).toContain(
      `${at(4).toISOString()} · Mette Hansen · signed privacy_policy v1 (sha256 ${sha256('Privatlivspolitik v1').slice(0, 12)}…)`,
    );
    expect(readme).toContain('published privacy_policy');
  });

  it('regenerating the document clears the signature; the old one cannot cover the new text', async () => {
    const again = await generateArtefact(db, tenantId, {
      caseId,
      kind: 'privacy_policy',
      locale: 'da',
      content: 'Privatlivspolitik v2, with a retention table',
      by: agent,
      now: at(7),
    });
    expect(again.version).toBe(2);
    const [row] = await artefactsForCase(db, tenantId, caseId);
    expect(row!.status).toBe('draft');
    expect(row!.signedBy).toBeNull();
    await expect(exportArtefact(db, tenantId, again.id)).rejects.toThrow(
      /v2 has not been signed off/,
    );
    await expect(
      publishArtefact(db, tenantId, again.id, { by: mette, now: at(8) }),
    ).rejects.toThrow(SignatureRequired);
    await signArtefact(db, tenantId, again.id, {
      by: mette,
      version: 2,
      hash: again.hash,
      now: at(9),
    });
    expect((await exportArtefact(db, tenantId, again.id)).version).toBe(2);
  });

  it('another tenant sees no documents', async () => {
    expect(await artefactsForCase(db, 't-someone-else', caseId)).toEqual([]);
  });
});
