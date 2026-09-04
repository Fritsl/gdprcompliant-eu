import {
  type ConsentFindingDraft,
  type EvidenceRef,
  type FormInventory,
  type FormRecord,
  type GraphEdgeKind,
  type GraphNode,
  type RecipientObservation,
  type RegisterRow,
  type Vendor,
} from '@gc/contracts';
import type { Connection, Db } from './client.js';
import {
  addEdge,
  assertFact,
  graphOf,
  registerProjection,
  type EdgeInput,
  type FactInput,
} from './graph.js';
import { withTenant } from './tenant.js';

// The processing register seeded from evidence (G-01). What the scan saw becomes draft
// rows on the case graph: an activity per kind of form and per kind of recipient, with
// the purpose, the likely basis, the data categories, the recipients and the transfer
// question pre-filled, every one derived, every one citing the evidence it came from.
// The vocabulary written here is keys into the register content, so a row reads in any
// language. A draft counts for nothing until a person confirms it; confirming restates
// the row as answered facts, corrected where the person says so, and supersedes the
// drafts; nothing is deleted.

export const REGISTER_ACTIVITIES = [
  'newsletter',
  'orders',
  'enquiries',
  'accounts',
  'sensitive_enquiries',
  'website_measurement',
  'email_and_documents',
] as const;
export type RegisterActivity = (typeof REGISTER_ACTIVITIES)[number];

const LIKELY_BASIS: Record<RegisterActivity, string> = {
  newsletter: 'consent',
  orders: 'contract',
  enquiries: 'legitimate_interest',
  accounts: 'contract',
  sensitive_enquiries: 'explicit_consent',
  website_measurement: 'consent',
  email_and_documents: 'legitimate_interest',
};

const SUBJECTS: Record<RegisterActivity, string[]> = {
  newsletter: ['subscribers'],
  orders: ['customers'],
  enquiries: ['enquirers'],
  accounts: ['account_holders'],
  sensitive_enquiries: ['enquirers'],
  website_measurement: ['visitors'],
  email_and_documents: ['staff_and_contacts'],
};

// Which activity a form is, read from what it collects, what it asks consent for, how
// it is submitted and where it lives.
export function classifyForm(form: FormRecord): RegisterActivity {
  const categories = new Set(form.fields.map((f) => f.category));
  const words = [
    form.action,
    form.submitLabel ?? '',
    form.page,
    ...form.fields.map((f) => `${f.name} ${f.label ?? ''}`),
  ]
    .join(' ')
    .toLowerCase();
  if (categories.has('health') || categories.has('belief')) return 'sensitive_enquiries';
  if (categories.has('credentials')) return 'accounts';
  if (
    categories.has('financial') ||
    /kassen|checkout|betal|order|ordre|k[øo]b|cart|kurv/.test(words)
  )
    return 'orders';
  if (
    form.controls.some((c) => c.purposes.includes('marketing')) ||
    /nyhedsbrev|newsletter|tilmeld|subscribe|signup|sign-up/.test(words)
  )
    return 'newsletter';
  return 'enquiries';
}

const CATEGORY_KEYS = [
  'health',
  'belief',
  'financial',
  'identity',
  'credentials',
  'contact',
  'free_text',
  'other',
] as const;

export interface SeedInput {
  readonly scanId: string;
  readonly now: Date;
  readonly forms?: FormInventory;
  readonly recipients?: readonly RecipientObservation[];
  readonly consent?: readonly ConsentFindingDraft[];
  readonly vendors?: readonly Vendor[];
}

export interface SeedResult {
  readonly rows: RegisterRow[];
  readonly nodes: number;
  readonly edges: number;
}

export async function seedRegister(
  connection: Connection,
  tenantId: string,
  caseId: string,
  input: SeedInput,
): Promise<SeedResult> {
  return withTenant(connection, tenantId, async (db) => {
    const s = new Seeder(db, tenantId, caseId, input);
    await s.forms();
    await s.recipients();
    await s.consent();
    await s.vendors();
    const rows = await registerProjection(db, caseId);
    return { rows, nodes: s.nodes, edges: s.edges };
  });
}

class Seeder {
  nodes = 0;
  edges = 0;
  private readonly sourceRef: string;
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
    private readonly caseId: string,
    private readonly input: SeedInput,
  ) {
    this.sourceRef = `scanner:${input.scanId}`;
  }

  private base(confidence: number, evidence: readonly EvidenceRef[]) {
    return {
      tenantId: this.tenantId,
      caseId: this.caseId,
      origin: 'derived' as const,
      confidence,
      sourceRef: this.sourceRef,
      evidence,
      at: this.input.now,
    };
  }

  private async fact(
    f: Omit<
      FactInput,
      'tenantId' | 'caseId' | 'origin' | 'sourceRef' | 'at' | 'evidence' | 'confidence'
    > & { confidence: number; evidence: readonly EvidenceRef[] },
  ): Promise<GraphNode> {
    const r = await assertFact(this.db, {
      ...this.base(f.confidence, f.evidence),
      kind: f.kind,
      key: f.key,
      attributes: f.attributes ?? {},
    });
    if (r.inserted) this.nodes += 1;
    return r.node;
  }

  private async link(
    kind: GraphEdgeKind,
    from: string,
    to: string,
    confidence: number,
    evidence: readonly EvidenceRef[],
  ) {
    const e: EdgeInput = { ...this.base(confidence, evidence), kind, from, to };
    await addEdge(this.db, e);
    this.edges += 1;
  }

  // An activity with its purpose, its likely basis and its subjects, once per kind.
  private async activity(
    kind: RegisterActivity,
    confidence: number,
    evidence: readonly EvidenceRef[],
    extra: Record<string, unknown> = {},
  ) {
    const activity = await this.fact({
      kind: 'activity',
      key: `activity:${kind}`,
      attributes: { name: kind, dataSubjects: SUBJECTS[kind], ...extra },
      confidence,
      evidence,
    });
    const purpose = await this.fact({
      kind: 'purpose',
      key: `purpose:${kind}`,
      attributes: { name: kind },
      confidence,
      evidence,
    });
    await this.link('has_purpose', activity.id, purpose.id, confidence, evidence);
    const basis = await this.fact({
      kind: 'legal_basis',
      key: `basis:activity:${kind}`,
      attributes: { name: LIKELY_BASIS[kind], likely: true },
      confidence: Math.min(confidence, 0.5),
      evidence,
    });
    await this.link('rests_on', activity.id, basis.id, Math.min(confidence, 0.5), evidence);
    return activity;
  }

  async forms() {
    const inv = this.input.forms;
    if (!inv) return;
    const byKind = new Map<RegisterActivity, FormRecord[]>();
    for (const form of inv.forms) {
      const kind = classifyForm(form);
      byKind.set(kind, [...(byKind.get(kind) ?? []), form]);
    }
    for (const [kind, forms] of byKind) {
      const evidence = [...new Map(forms.map((f) => [f.evidence.evidenceId, f.evidence])).values()];
      const activity = await this.activity(kind, 0.6, evidence, {
        pages: [...new Set(forms.map((f) => f.page))],
      });
      const categories = new Set<string>();
      for (const f of forms)
        for (const field of f.fields)
          if ((CATEGORY_KEYS as readonly string[]).includes(field.category))
            categories.add(field.category);
      for (const c of [...categories].sort()) {
        const node = await this.fact({
          kind: 'data_category',
          key: `category:${c}`,
          attributes: { name: c },
          confidence: 0.6,
          evidence,
        });
        await this.link('processes', activity.id, node.id, 0.6, evidence);
      }
    }
  }

  // Recipients the first load contacted outside the EEA, each with its determination.
  async recipients() {
    for (const o of this.input.recipients ?? []) {
      if (o.check !== 'transfers' || o.outcome !== 'fail') continue;
      const outside =
        (o.detail['outside'] as {
          host: string;
          recipient: string;
          jurisdiction: string;
          determination?: {
            vendorId: string;
            situation: string;
            contracting: { name: string; country: string };
            parent: { name: string; country: string };
            statement: Record<string, string>;
            adequacy?: unknown;
            dpf?: unknown;
          };
        }[]) ?? [];
      if (outside.length === 0) continue;
      const activity = await this.activity('website_measurement', 0.7, o.evidence);
      const category = await this.fact({
        kind: 'data_category',
        key: 'category:online_identifiers',
        attributes: { name: 'online_identifiers' },
        confidence: 0.7,
        evidence: o.evidence,
      });
      await this.link('processes', activity.id, category.id, 0.7, o.evidence);
      for (const r of outside) {
        const d = r.determination;
        const vendorKey = d ? `vendor:${d.vendorId}` : `vendor:host:${r.host}`;
        const vendor = await this.fact({
          kind: 'vendor',
          key: vendorKey,
          attributes: d
            ? {
                name: d.contracting.name,
                country: d.contracting.country,
                parent: d.parent.name,
                parentCountry: d.parent.country,
                hosts: [r.host],
              }
            : { name: r.recipient, country: r.jurisdiction, hosts: [r.host], unresolved: true },
          confidence: d ? 0.7 : 0.5,
          evidence: o.evidence,
        });
        await this.link('shared_with', activity.id, vendor.id, 0.7, o.evidence);
        if (d) {
          const transfer = await this.fact({
            kind: 'transfer',
            key: `transfer:${d.vendorId}`,
            attributes: {
              situation: d.situation,
              statement: d.statement,
              adequacy: d.adequacy ?? null,
              dpf: d.dpf ?? null,
            },
            confidence: 0.7,
            evidence: o.evidence,
          });
          await this.link('transfers_via', vendor.id, transfer.id, 0.7, o.evidence);
        }
      }
    }
  }

  // Hosts a consent finding names are recipients too, resolved or not.
  async consent() {
    const drafts = (this.input.consent ?? []).filter(
      (d) => d.hosts.length > 0 && d.evidence.length > 0,
    );
    if (drafts.length === 0) return;
    const evidence = [
      ...new Map(drafts.flatMap((d) => d.evidence).map((e) => [e.evidenceId, e])).values(),
    ];
    const activity = await this.activity('website_measurement', 0.6, evidence);
    for (const host of [...new Set(drafts.flatMap((d) => d.hosts))].sort()) {
      const vendor = await this.fact({
        kind: 'vendor',
        key: `vendor:host:${host}`,
        attributes: { name: host, hosts: [host], unresolved: true },
        confidence: 0.5,
        evidence,
      });
      await this.link('shared_with', activity.id, vendor.id, 0.6, evidence);
    }
  }

  // Vendor rows from the DNS read (D-01, S-07): the company's own mail and documents.
  async vendors() {
    const rows = (this.input.vendors ?? []).filter((v) => v.provenance.evidence.length > 0);
    if (rows.length === 0) return;
    const evidence = [
      ...new Map(rows.flatMap((v) => v.provenance.evidence).map((e) => [e.evidenceId, e])).values(),
    ];
    const activity = await this.activity('email_and_documents', 0.6, evidence);
    const category = await this.fact({
      kind: 'data_category',
      key: 'category:correspondence',
      attributes: { name: 'correspondence' },
      confidence: 0.6,
      evidence: evidence,
    });
    await this.link('processes', activity.id, category.id, 0.6, evidence);
    for (const v of rows) {
      const vendor = await this.fact({
        kind: 'vendor',
        key: `vendor:${v.id}`,
        attributes: {
          name: v.legalEntity?.name ?? v.label,
          country: v.jurisdiction,
          ...(v.parentJurisdiction ? { parentCountry: v.parentJurisdiction } : {}),
          hosts: v.hosts,
          ...(v.resolution !== 'resolved' ? { unresolved: true } : {}),
        },
        confidence: v.resolution === 'resolved' ? 0.7 : 0.5,
        evidence: v.provenance.evidence,
      });
      await this.link('shared_with', activity.id, vendor.id, 0.6, v.provenance.evidence);
    }
  }
}

export const registerRows = (
  connection: Connection,
  tenantId: string,
  caseId: string,
): Promise<RegisterRow[]> =>
  withTenant(connection, tenantId, (db) => registerProjection(db, caseId));

export interface RowCorrections {
  readonly name?: string;
  readonly dataSubjects?: readonly string[];
  readonly purposes?: readonly string[];
  readonly dataCategories?: readonly string[];
  readonly legalBases?: readonly string[];
  readonly retention?: string;
  readonly security?: string;
}

export interface ConfirmInput {
  readonly caseId: string;
  readonly activityId: string;
  readonly answerId: string;
  readonly by: string;
  readonly at: Date;
  readonly corrections?: RowCorrections;
}

// A person confirms a row, correcting what needs it. Every part of the row is restated
// as an answered fact; the drafts it replaces are superseded, not deleted; the edges
// between the answered facts are answered too.
export async function confirmRegisterRow(
  connection: Connection,
  tenantId: string,
  input: ConfirmInput,
): Promise<RegisterRow> {
  return withTenant(connection, tenantId, async (db) => {
    const g = await graphOf(db, input.caseId);
    const activity = g.nodes.find(
      (n) => n.id === input.activityId && n.kind === 'activity' && !n.supersededBy,
    );
    if (!activity) throw new Error(`no live activity ${input.activityId} on ${input.caseId}`);
    const c = input.corrections ?? {};
    const answered = {
      tenantId,
      caseId: input.caseId,
      origin: 'answered' as const,
      confidence: 1,
      sourceRef: `answer:${input.answerId}`,
      answerId: input.answerId,
      at: input.at,
    };
    const live = (id: string) => g.nodes.find((n) => n.id === id && !n.supersededBy);
    const outOf = (from: string, kind: GraphEdgeKind) =>
      g.edges
        .filter((e) => e.kind === kind && e.from === from)
        .map((e) => live(e.to))
        .filter((n): n is GraphNode => n !== undefined);

    // Supersede a draft with its answered restatement: a supersedes edge, the mark on
    // the draft, and any open contradiction between the two closed by the answer.
    const supersede = async (winner: GraphNode, loser: GraphNode) => {
      if (winner.id === loser.id) return;
      await addEdge(db, { ...answered, kind: 'supersedes', from: winner.id, to: loser.id });
      const { graphNodes, graphEdges } = await import('./schema.js');
      const { eq, and, or } = await import('drizzle-orm');
      await db
        .update(graphNodes)
        .set({ supersededBy: winner.id })
        .where(eq(graphNodes.id, loser.id));
      const open = await db
        .select()
        .from(graphEdges)
        .where(
          and(
            eq(graphEdges.kind, 'contradicts'),
            or(
              and(eq(graphEdges.fromNode, winner.id), eq(graphEdges.toNode, loser.id)),
              and(eq(graphEdges.fromNode, loser.id), eq(graphEdges.toNode, winner.id)),
            ),
          ),
        );
      for (const e of open) {
        await db
          .update(graphEdges)
          .set({
            attributes: {
              ...(e.attributes as Record<string, unknown>),
              resolved: { kept: winner.id, by: input.by, at: input.at.toISOString() },
            },
          })
          .where(eq(graphEdges.id, e.id));
      }
    };

    const restate = async (
      draft: GraphNode,
      attributes: Record<string, unknown>,
    ): Promise<GraphNode> => {
      const r = await assertFact(db, { ...answered, kind: draft.kind, key: draft.key, attributes });
      await supersede(r.node, draft);
      return r.node;
    };
    const named = async (
      kind: GraphNode['kind'],
      keyPrefix: string,
      names: readonly string[],
      drafts: GraphNode[],
    ): Promise<GraphNode[]> => {
      const out: GraphNode[] = [];
      for (const name of names) {
        const draft = drafts.find((d) => d.attributes['name'] === name);
        const r = draft
          ? await restate(draft, { ...draft.attributes, name })
          : (
              await assertFact(db, {
                ...answered,
                kind,
                key: `${keyPrefix}:${name}`,
                attributes: { name },
              })
            ).node;
        out.push(r);
      }
      for (const draft of drafts)
        if (!names.includes(draft.attributes['name'] as string))
          await supersede(out[0] ?? draft, draft);
      return out;
    };

    const purposes = outOf(activity.id, 'has_purpose');
    const categories = outOf(activity.id, 'processes');
    const bases = outOf(activity.id, 'rests_on');
    const vendors = outOf(activity.id, 'shared_with');
    const risks = outOf(activity.id, 'carries_risk');

    const newActivity = await restate(activity, {
      ...activity.attributes,
      ...(c.name ? { name: c.name } : {}),
      ...(c.dataSubjects ? { dataSubjects: [...c.dataSubjects] } : {}),
      ...(c.retention ? { retention: c.retention } : {}),
      ...(c.security ? { security: c.security } : {}),
    });
    const newPurposes = await named(
      'purpose',
      'purpose',
      c.purposes ?? purposes.map((p) => p.attributes['name'] as string),
      purposes,
    );
    const newCategories = await named(
      'data_category',
      'category',
      c.dataCategories ?? categories.map((p) => p.attributes['name'] as string),
      categories,
    );
    const newBases = await named(
      'legal_basis',
      `basis:${activity.key}`,
      c.legalBases ?? bases.map((p) => p.attributes['name'] as string),
      bases,
    );
    // Recipients and risks stay what the scan saw, confirmed as such.
    const newVendors: GraphNode[] = [];
    for (const v of vendors) newVendors.push(await restate(v, v.attributes));
    const newRisks: GraphNode[] = [];
    for (const r of risks) newRisks.push(await restate(r, r.attributes));

    const relink = async (kind: GraphEdgeKind, tos: GraphNode[]) => {
      for (const to of tos)
        await addEdge(db, { ...answered, kind, from: newActivity.id, to: to.id });
    };
    await relink('has_purpose', newPurposes);
    await relink('processes', newCategories);
    await relink('rests_on', newBases);
    await relink('shared_with', newVendors);
    await relink('carries_risk', newRisks);
    // A vendor's transfer rides along under the confirmed vendor.
    for (const [i, v] of vendors.entries()) {
      for (const t of outOf(v.id, 'transfers_via')) {
        await addEdge(db, {
          ...answered,
          kind: 'transfers_via',
          from: newVendors[i]!.id,
          to: t.id,
        });
      }
    }
    const rows = await registerProjection(db, input.caseId);
    return rows.find((r) => r.activityId === newActivity.id)!;
  });
}

// How far the drafts are from a confirmed register, counted in fields a person would
// have to change; and what writing the same register from nothing would cost.
export interface RegisterTruthRow {
  readonly name: string;
  readonly purposes: readonly string[];
  readonly dataCategories: readonly string[];
  readonly legalBases: readonly string[];
  readonly recipients: readonly string[];
}

export interface EditEffort {
  readonly fromDrafts: number;
  readonly fromNothing: number;
  readonly detail: { activity: string; edits: number; missing: boolean }[];
}

const same = (a: readonly string[], b: readonly string[]) =>
  [...a].sort().join('|') === [...b].sort().join('|');

export function editEffort(
  drafts: readonly RegisterRow[],
  truth: readonly RegisterTruthRow[],
): EditEffort {
  let fromDrafts = 0;
  let fromNothing = 0;
  const detail: EditEffort['detail'] = [];
  for (const t of truth) {
    const fields: [readonly string[], readonly string[]][] = [];
    const d = drafts.find((r) => r.name === t.name);
    fromNothing +=
      1 + t.purposes.length + t.dataCategories.length + t.legalBases.length + t.recipients.length;
    if (!d) {
      const edits =
        1 + t.purposes.length + t.dataCategories.length + t.legalBases.length + t.recipients.length;
      fromDrafts += edits;
      detail.push({ activity: t.name, edits, missing: true });
      continue;
    }
    fields.push(
      [d.purposes, t.purposes],
      [d.dataCategories, t.dataCategories],
      [d.legalBases, t.legalBases],
      [d.recipients.map((r) => r.name), t.recipients],
    );
    let edits = 0;
    for (const [have, want] of fields) {
      if (same(have, want)) continue;
      edits +=
        want.filter((w) => !have.includes(w)).length + have.filter((h) => !want.includes(h)).length;
    }
    fromDrafts += edits;
    detail.push({ activity: t.name, edits, missing: false });
  }
  for (const d of drafts)
    if (!truth.some((t) => t.name === d.name)) {
      fromDrafts += 1;
      detail.push({ activity: d.name, edits: 1, missing: false });
    }
  return { fromDrafts, fromNothing, detail };
}
