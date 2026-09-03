import type { DemandLedgerEntry } from '@gc/contracts';
import type { Catalogue } from './catalogue.js';
import { resolveRemedy, type ResolveContext, type Resolution } from './resolver.js';

// A no_solution outcome satisfies the constraint — the finding still has a remedy — and
// is recorded on the demand ledger (R-05): what the customer needed, which sector and
// country, and why nothing answered. The ledger store is R-05's; this is the write.

export interface DemandRecord extends DemandLedgerEntry {
  readonly findingTypeId: string;
  readonly jurisdiction: string;
  readonly caseId: string;
  readonly sector?: string;
  readonly cause: string;
}

export interface DemandLedger {
  record(entry: DemandRecord): Promise<void> | void;
}

export interface DemandContext {
  readonly caseId: string;
  readonly sector?: string;
  readonly now?: () => Date;
}

// Resolve, and if the answer is a no_solution, write it down before returning it.
export async function resolveAndRecord(
  catalogue: Catalogue,
  findingTypeId: string,
  context: ResolveContext,
  ledger: DemandLedger,
  demand: DemandContext,
): Promise<Resolution> {
  const resolution = resolveRemedy(catalogue, findingTypeId, context);
  if (resolution.remedy.kind === 'no_solution') {
    const at = (demand.now ?? (() => new Date()))().toISOString();
    await ledger.record({
      gap: resolution.remedy.demandGap,
      seen: 1,
      sectors: demand.sector ? [demand.sector] : 'all',
      answer: 'none',
      firstSeenAt: at,
      lastSeenAt: at,
      findingTypeId,
      jurisdiction: context.jurisdiction,
      caseId: demand.caseId,
      ...(demand.sector !== undefined ? { sector: demand.sector } : {}),
      cause: resolution.reason,
    });
  }
  return resolution;
}

// Enough of a ledger for tests and for anything that runs before R-05 lands.
export class MemoryDemandLedger implements DemandLedger {
  readonly entries: DemandRecord[] = [];
  record(entry: DemandRecord): void {
    this.entries.push(entry);
  }
}
