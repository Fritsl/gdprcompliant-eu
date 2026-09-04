import { EvidenceSchema, canonicalJson, sha256, type Evidence } from '@gc/contracts';
import type { Worker } from '../dispatcher.js';
import { claimOf, done, failed, refTo, type WorkerIdentity } from './shared.js';

// The registry adapter (A-05): asks one business register one question and records
// what it answered, as evidence. The register itself is behind the lookup it is given
// (D-03 supplies them, recorded for the tests); the adapter has no other tool.

export interface RegistryMatch {
  readonly registryId: string;
  readonly name: string;
  // The record as the register returned it, kept whole.
  readonly record: Record<string, unknown>;
  readonly source: { readonly url: string; readonly host: string; readonly fetchedAt: string };
}

export interface RegistryAdapterDeps extends WorkerIdentity {
  readonly lookup: (
    registry: string,
    query: {
      name?: string | undefined;
      registryId?: string | undefined;
      domain?: string | undefined;
    },
  ) => Promise<readonly RegistryMatch[]>;
  readonly now?: () => Date;
}

export const REGISTRY_ADAPTER = 'registry_adapter';

export function createRegistryAdapter(deps: RegistryAdapterDeps): Worker<'registry_lookup'> {
  const now = deps.now ?? (() => new Date());
  return async (task) => {
    const at = now();
    let matches: readonly RegistryMatch[];
    try {
      matches = await deps.lookup(task.payload.registry, task.payload.query);
    } catch (e) {
      return failed(task, `${task.payload.registry} did not answer: ${(e as Error).message}`, true);
    }
    const evidence: Evidence[] = matches.map((m) => {
      const body = canonicalJson({ registry: task.payload.registry, ...m.record });
      const hash = sha256(body);
      return EvidenceSchema.parse({
        id: `registry_record:${hash.slice(0, 16)}`,
        tenantId: deps.tenantId,
        caseId: deps.caseId,
        scanId: task.id,
        kind: 'registry_record',
        capturedAt: m.source.fetchedAt,
        source: { url: m.source.url, host: m.source.host },
        body,
        hash,
        caption: `${task.payload.registry}: ${m.name} (${m.registryId})`,
      });
    });
    const claims = matches.map((m, i) =>
      claimOf({
        caseId: deps.caseId,
        kind: 'observation',
        statement: `${task.payload.registry} lists ${m.name} under ${m.registryId}.`,
        evidence: [refTo(evidence[i]!)],
        worker: REGISTRY_ADAPTER,
        taskId: task.id,
        at,
      }),
    );
    return done(
      task,
      {
        matches: matches.map((m, i) => ({
          registryId: m.registryId,
          name: m.name,
          evidence: refTo(evidence[i]!),
        })),
      },
      { claims, evidence },
    );
  };
}
