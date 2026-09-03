import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BindingTableSchema,
  JurisdictionBindingSchema,
  SUPPORTED_JURISDICTIONS,
  parseDecisionRef,
  parseProvisionRef,
  type BindingTable,
  type Citation,
  type FindingTypeId,
  type Jurisdiction,
  type JurisdictionBinding,
} from '@gc/contracts';

// Jurisdiction bindings (I-02). A finding type has one identity everywhere (CNS-02 is
// CNS-02 in Aarhus and in Aachen) and, per jurisdiction, a binding: the provisions it
// rests on, the authority that would hear a complaint, the guide that explains it. The
// bindings are content, one file per jurisdiction under content/bindings, reviewable
// without reading code; docs/bindings.md is generated from them. Detector code never
// names an article. A jurisdiction without a table, or a type without a row, is an
// explicit failure here, never a fall-back to another country's law.

export const BINDINGS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../content/bindings');

export class UnsupportedJurisdiction extends Error {
  constructor(
    public readonly jurisdiction: string,
    public readonly supported: readonly string[],
  ) {
    super(
      `no binding table for jurisdiction ${jurisdiction}; the product speaks ${supported.join(', ')} and does not answer with another country's law`,
    );
    this.name = 'UnsupportedJurisdiction';
  }
}

export class UnboundFindingType extends Error {
  constructor(
    public readonly findingTypeId: string,
    public readonly jurisdiction: string,
  ) {
    super(`${findingTypeId} has no binding in ${jurisdiction}`);
    this.name = 'UnboundFindingType';
  }
}

// A row's citations are written the way a lawyer writes them, "GDPR, Art. 7(3)"; here
// they become the typed citations the corpus resolves. A row that cannot be parsed is a
// content error, raised at load.
export function citationFromRow(
  row: BindingTable['bindings'][number]['citations'][number],
): Citation {
  const extra: { note?: string; jurisdiction?: string } = {};
  if (row.note !== undefined) extra.note = row.note;
  if (row.jurisdiction !== undefined) extra.jurisdiction = row.jurisdiction;
  const provision = parseProvisionRef(row.instrument, row.ref, extra);
  if (provision) return provision;
  if (/^(case law|decision|judgment)$/i.test(row.instrument)) {
    const decision = parseDecisionRef(row.ref, extra);
    if (decision) return decision;
  }
  throw new Error(
    `binding citation "${row.instrument} ${row.ref}" is not a reference the corpus can resolve`,
  );
}

export function loadBindingTable(file: string): BindingTable {
  const parsed = BindingTableSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`${file}: ${issues.join('; ')}`);
  }
  for (const b of parsed.data.bindings) b.citations.forEach(citationFromRow);
  return parsed.data;
}

export function loadBindingTables(dir: string = BINDINGS_DIR): Map<Jurisdiction, BindingTable> {
  const out = new Map<Jurisdiction, BindingTable>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const table = loadBindingTable(join(dir, f));
    if (f !== `${table.jurisdiction}.json`) {
      throw new Error(
        `${f}: the table says it is for ${table.jurisdiction}; name the file after it`,
      );
    }
    out.set(table.jurisdiction, table);
  }
  return out;
}

let cached: Map<Jurisdiction, BindingTable> | undefined;
export const bindingTables = (): Map<Jurisdiction, BindingTable> =>
  (cached ??= loadBindingTables());

export type BindingResolution =
  | { readonly ok: true; readonly binding: JurisdictionBinding }
  | {
      readonly ok: false;
      readonly reason: 'unsupported_jurisdiction';
      readonly jurisdiction: string;
      readonly supported: readonly Jurisdiction[];
    }
  | {
      readonly ok: false;
      readonly reason: 'unbound_finding_type';
      readonly findingTypeId: string;
      readonly jurisdiction: Jurisdiction;
    };

export function resolveBinding(
  findingTypeId: FindingTypeId,
  jurisdiction: Jurisdiction,
  tables: Map<Jurisdiction, BindingTable> = bindingTables(),
): BindingResolution {
  const table = tables.get(jurisdiction);
  if (!table) {
    return {
      ok: false,
      reason: 'unsupported_jurisdiction',
      jurisdiction,
      supported: [...tables.keys()],
    };
  }
  const row = table.bindings.find((b) => b.findingTypeId === findingTypeId);
  if (!row) return { ok: false, reason: 'unbound_finding_type', findingTypeId, jurisdiction };
  const authority: JurisdictionBinding['authority'] = { name: table.authority.name };
  if (table.authority.url !== undefined) authority.url = table.authority.url;
  return {
    ok: true,
    binding: JurisdictionBindingSchema.parse({
      findingTypeId,
      jurisdiction,
      citations: row.citations.map(citationFromRow),
      authority,
      guideId: row.guideId,
      version: row.version ?? table.version,
    }),
  };
}

// The binding, or a typed error. Never another jurisdiction's binding.
export function bindingFor(
  findingTypeId: FindingTypeId,
  jurisdiction: Jurisdiction,
  tables?: Map<Jurisdiction, BindingTable>,
): JurisdictionBinding {
  const r = resolveBinding(findingTypeId, jurisdiction, tables);
  if (r.ok) return r.binding;
  if (r.reason === 'unsupported_jurisdiction')
    throw new UnsupportedJurisdiction(jurisdiction, r.supported);
  throw new UnboundFindingType(findingTypeId, jurisdiction);
}

export interface BindingGap {
  readonly findingTypeId: FindingTypeId;
  readonly jurisdiction: Jurisdiction;
}

// Every finding type the product can raise, bound in every supported jurisdiction.
export function bindingCoverage(
  findingTypeIds: readonly FindingTypeId[],
  jurisdictions: readonly Jurisdiction[] = SUPPORTED_JURISDICTIONS,
  tables: Map<Jurisdiction, BindingTable> = bindingTables(),
): BindingGap[] {
  const gaps: BindingGap[] = [];
  for (const jurisdiction of jurisdictions) {
    for (const findingTypeId of findingTypeIds) {
      if (!resolveBinding(findingTypeId, jurisdiction, tables).ok)
        gaps.push({ findingTypeId, jurisdiction });
    }
  }
  return gaps;
}
