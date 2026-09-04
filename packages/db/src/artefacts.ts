import { and, eq } from 'drizzle-orm';
import { sha256, type Actor, type ArtefactKind } from '@gc/contracts';
import type { Connection } from './client.js';
import { artefacts } from './schema.js';
import { withTenant } from './tenant.js';
import { appendCaseEvent } from './timeline.js';

// The human sign-off gate (A-09). A generated document is a draft until a named person
// signs the version and the bytes they saw. Only a signed document can be published or
// exported; regenerating it makes a new version and clears the signature, so nobody's
// name ever stands under text they did not read. Every step is on the timeline.

export class SignatureRequired extends Error {
  constructor(
    public readonly artefactId: string,
    public readonly detail: string,
  ) {
    super(`${artefactId}: ${detail}`);
    this.name = 'SignatureRequired';
  }
}

export class StaleSignature extends Error {
  constructor(
    public readonly artefactId: string,
    public readonly detail: string,
  ) {
    super(`${artefactId}: ${detail}`);
    this.name = 'StaleSignature';
  }
}

export interface Signer {
  readonly userId: string;
  readonly name: string;
}

export const artefactId = (caseId: string, kind: ArtefactKind): string =>
  `art-${sha256(`${caseId}|${kind}`).slice(0, 16)}`;

export interface GeneratedArtefact {
  readonly id: string;
  readonly kind: ArtefactKind;
  readonly version: number;
  readonly hash: string;
}

// A new document, or a new version of the one the case already has for this kind.
// Either way it is a draft and unsigned.
export async function generateArtefact(
  connection: Connection,
  tenantId: string,
  input: {
    readonly caseId: string;
    readonly kind: ArtefactKind;
    readonly locale: string;
    readonly content: string;
    readonly by: Actor;
    readonly now?: Date;
  },
): Promise<GeneratedArtefact> {
  const now = input.now ?? new Date();
  const id = artefactId(input.caseId, input.kind);
  const hash = sha256(input.content);
  return withTenant(connection, tenantId, async (db) => {
    const [existing] = await db.select().from(artefacts).where(eq(artefacts.id, id));
    const version = existing ? existing.version + 1 : 1;
    const row = {
      version,
      locale: input.locale,
      content: input.content,
      hash,
      status: 'draft' as const,
      generatedAt: now,
      generatedBy: input.by,
      signedAt: null,
      signedBy: null,
      signedVersion: null,
      signedHash: null,
      publishedAt: null,
      publishedUrl: null,
    };
    if (existing) await db.update(artefacts).set(row).where(eq(artefacts.id, id));
    else {
      await db.insert(artefacts).values({
        id,
        tenantId,
        sourceRef: `artefact:${input.kind}`,
        caseId: input.caseId,
        kind: input.kind,
        ...row,
      });
    }
    await appendCaseEvent(db, {
      tenantId,
      caseId: input.caseId,
      at: now,
      actor: input.by,
      type: 'artefact_generated',
      payload: { artefactId: id, kind: input.kind },
    });
    return { id, kind: input.kind, version, hash };
  });
}

async function load(db: Parameters<Parameters<typeof withTenant>[2]>[0], id: string) {
  const [row] = await db.select().from(artefacts).where(eq(artefacts.id, id));
  if (!row) throw new Error(`no artefact ${id}`);
  return row;
}

// A named person signs the version and the bytes they saw. Anything else is refused.
export async function signArtefact(
  connection: Connection,
  tenantId: string,
  id: string,
  signature: {
    readonly by: Actor;
    readonly version: number;
    readonly hash: string;
    readonly now?: Date;
  },
): Promise<{ readonly version: number; readonly hash: string; readonly by: Signer }> {
  if (signature.by.kind !== 'person') {
    throw new SignatureRequired(id, `a sign-off is a person's, not a ${signature.by.kind}'s`);
  }
  const by: Signer = { userId: signature.by.userId, name: signature.by.name };
  const now = signature.now ?? new Date();
  return withTenant(connection, tenantId, async (db) => {
    const row = await load(db, id);
    if (signature.version !== row.version) {
      throw new StaleSignature(
        id,
        `signed version ${signature.version}, the document is at version ${row.version}`,
      );
    }
    if (signature.hash !== row.hash) {
      throw new StaleSignature(id, 'the signed bytes are not the document’s bytes');
    }
    await db
      .update(artefacts)
      .set({
        status: 'signed',
        signedAt: now,
        signedBy: by,
        signedVersion: row.version,
        signedHash: row.hash,
      })
      .where(eq(artefacts.id, id));
    await appendCaseEvent(db, {
      tenantId,
      caseId: row.caseId,
      at: now,
      actor: signature.by,
      type: 'artefact_signed',
      payload: {
        artefactId: id,
        kind: row.kind as ArtefactKind,
        version: row.version,
        hash: row.hash,
        by: by.name,
      },
    });
    return { version: row.version, hash: row.hash, by };
  });
}

function assertSigned(row: typeof artefacts.$inferSelect): void {
  if (row.status === 'draft' || row.signedHash === null || row.signedVersion === null) {
    throw new SignatureRequired(row.id, `${row.kind} v${row.version} has not been signed off`);
  }
  if (row.signedVersion !== row.version || row.signedHash !== row.hash) {
    throw new StaleSignature(
      row.id,
      `the sign-off is for v${row.signedVersion}; the document is at v${row.version}`,
    );
  }
}

export async function publishArtefact(
  connection: Connection,
  tenantId: string,
  id: string,
  options: { readonly by: Actor; readonly url?: string; readonly now?: Date },
): Promise<{ readonly version: number; readonly hash: string }> {
  const now = options.now ?? new Date();
  return withTenant(connection, tenantId, async (db) => {
    const row = await load(db, id);
    assertSigned(row);
    await db
      .update(artefacts)
      .set({ status: 'published', publishedAt: now, publishedUrl: options.url ?? null })
      .where(and(eq(artefacts.id, id), eq(artefacts.version, row.version)));
    await appendCaseEvent(db, {
      tenantId,
      caseId: row.caseId,
      at: now,
      actor: options.by,
      type: 'artefact_published',
      payload: {
        artefactId: id,
        kind: row.kind as ArtefactKind,
        ...(options.url ? { url: options.url } : {}),
      },
    });
    return { version: row.version, hash: row.hash };
  });
}

export interface ExportedArtefact {
  readonly id: string;
  readonly kind: ArtefactKind;
  readonly version: number;
  readonly hash: string;
  readonly content: string;
  readonly signedBy: Signer;
  readonly signedAt: string;
}

// The document's bytes, with the signature that lets them leave.
export async function exportArtefact(
  connection: Connection,
  tenantId: string,
  id: string,
): Promise<ExportedArtefact> {
  return withTenant(connection, tenantId, async (db) => {
    const row = await load(db, id);
    assertSigned(row);
    return {
      id: row.id,
      kind: row.kind as ArtefactKind,
      version: row.version,
      hash: row.hash,
      content: row.content,
      signedBy: row.signedBy as Signer,
      signedAt: new Date(row.signedAt!).toISOString(),
    };
  });
}

export async function artefactsForCase(connection: Connection, tenantId: string, caseId: string) {
  return withTenant(connection, tenantId, (db) =>
    db.select().from(artefacts).where(eq(artefacts.caseId, caseId)).orderBy(artefacts.kind),
  );
}
