import PDFDocument from 'pdfkit';
import type { Locale, LocalisedText } from '@gc/contracts';
import { localise } from '@gc/i18n';
import type { ProcessorInput, SubProcessorRow } from './agreement.js';
import { disclaimerText } from './disclaimer.js';

// The supply-chain map (D-08): the company, the suppliers that process its data, and
// the suppliers they in turn use, as the register and the walk (D-07) recorded them.
// Laid out in columns by level so that three levels and sixty nodes stay legible; every
// node carries its country and a link to the evidence that placed it there; drawn in
// black and greys only, with level told by the shape of the box and a cycle by a dashed
// line, so the map reads the same printed in greyscale. The SVG and the PDF are drawn
// from one model, so they cannot disagree.

export const MAP_MAX_NODES = 60;
export const MAP_MAX_LEVELS = 3;

const COLUMN_WIDTH = 250;
const NODE_WIDTH = 200;
const NODE_HEIGHT = 44;
const ROW_GAP = 14;
const MARGIN = 28;
const LABEL_CHARS = 26;

export interface MapCompany {
  readonly domain: string;
  readonly name?: string;
  readonly country: string;
}

export interface MapInput {
  readonly company: MapCompany;
  readonly processors: readonly (ProcessorInput & { readonly evidenceId?: string })[];
  readonly subProcessors: readonly SubProcessorRow[];
  readonly locale: Locale;
  readonly generatedAt: Date;
  // Where a node's evidence link points: the page, the anchor, the evidence id.
  readonly evidenceHref?: (evidenceId: string) => string;
}

export interface MapNode {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly country?: string;
  readonly level: number;
  readonly evidenceId?: string;
  readonly href?: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MapEdge {
  readonly from: string;
  readonly to: string;
  readonly cycle: boolean;
}

export interface MapModel {
  readonly title: string;
  readonly legend: readonly string[];
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
  readonly width: number;
  readonly height: number;
  // Nodes the cap left off, so the map can say so rather than hide it.
  readonly omitted: number;
  readonly generatedAt: string;
  readonly locale: Locale;
}

const WORDS: Record<string, LocalisedText> = {
  title: { en: 'Supply chain', da: 'Leverandørkæde', de: 'Lieferkette' },
  company: { en: 'the company', da: 'virksomheden', de: 'das Unternehmen' },
  processor: { en: 'processor', da: 'databehandler', de: 'Auftragsverarbeiter' },
  sub: { en: 'sub-processor', da: 'underdatabehandler', de: 'Unterauftragsverarbeiter' },
  cycle: {
    en: 'dashed: names a company already on the map',
    da: 'stiplet: nævner en virksomhed, der allerede er på kortet',
    de: 'gestrichelt: nennt ein Unternehmen, das schon auf der Karte ist',
  },
  omitted: {
    en: '{{n}} more not drawn',
    da: '{{n}} flere ikke tegnet',
    de: '{{n}} weitere nicht gezeichnet',
  },
  unknown: { en: 'country unknown', da: 'land ukendt', de: 'Land unbekannt' },
  generated: { en: 'Generated', da: 'Udarbejdet', de: 'Erzeugt' },
};

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Columns by level, rows by name: the company alone on the left, its processors next,
// their sub-processors after that. Within the cap, no two boxes touch; beyond it the
// count is kept and shown.
export function layoutSupplyChain(input: MapInput): MapModel {
  const t = (k: string, values: Record<string, string> = {}) =>
    localise(WORDS[k]!, input.locale).value.replace(
      /\{\{(\w+)\}\}/g,
      (_, v: string) => values[v] ?? '',
    );
  const href = (id: string | undefined) =>
    id && input.evidenceHref ? input.evidenceHref(id) : undefined;
  type Pending = Omit<MapNode, 'x' | 'y' | 'width' | 'height'>;
  const pending: Pending[] = [];
  const edges: MapEdge[] = [];
  const seen = new Set<string>();
  const add = (n: Pending) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    pending.push(n);
  };
  const companyId = `company:${input.company.domain}`;
  add({
    id: companyId,
    label: truncate(input.company.name ?? input.company.domain, LABEL_CHARS),
    name: input.company.name ?? input.company.domain,
    country: input.company.country,
    level: 0,
  });
  for (const p of [...input.processors].sort((a, b) => a.name.localeCompare(b.name))) {
    add({
      id: p.nodeId,
      label: truncate(p.name, LABEL_CHARS),
      name: p.name,
      ...(p.country ? { country: p.country } : {}),
      level: 1,
      ...(p.evidenceId ? { evidenceId: p.evidenceId } : {}),
      ...(href(p.evidenceId) !== undefined ? { href: href(p.evidenceId)! } : {}),
    });
    edges.push({ from: companyId, to: p.nodeId, cycle: false });
  }
  const byKey = new Map<string, string>();
  for (const p of input.processors) if (p.key) byKey.set(p.key, p.nodeId);
  const subs = [...input.subProcessors].sort(
    (a, b) => a.level - b.level || a.name.localeCompare(b.name),
  );
  for (const s of subs) {
    const from =
      s.engagedBy.key && byKey.has(s.engagedBy.key)
        ? byKey.get(s.engagedBy.key)!
        : s.engagedBy.nodeId;
    const level = Math.min(s.level, MAP_MAX_LEVELS);
    const existing = pending.find((n) => n.id === s.nodeId);
    if (!existing) {
      add({
        id: s.nodeId,
        label: truncate(s.name, LABEL_CHARS),
        name: s.name,
        ...(s.country ? { country: s.country } : {}),
        level,
        evidenceId: s.evidenceId,
        ...(href(s.evidenceId) !== undefined ? { href: href(s.evidenceId)! } : {}),
      });
    }
    if (seen.has(from)) {
      const target = pending.find((n) => n.id === s.nodeId)!;
      const source = pending.find((n) => n.id === from)!;
      edges.push({ from, to: s.nodeId, cycle: target.level <= source.level });
    }
  }
  const kept = pending.slice(0, MAP_MAX_NODES);
  const keptIds = new Set(kept.map((n) => n.id));
  const omitted = pending.length - kept.length;
  const columns = new Map<number, Pending[]>();
  for (const n of kept) columns.set(n.level, [...(columns.get(n.level) ?? []), n]);
  const levels = [...columns.keys()].sort((a, b) => a - b);
  const tallest = Math.max(...levels.map((l) => columns.get(l)!.length));
  const height = MARGIN * 2 + tallest * (NODE_HEIGHT + ROW_GAP) - ROW_GAP + 40;
  const nodes: MapNode[] = [];
  for (const level of levels) {
    const column = columns.get(level)!;
    const x = MARGIN + level * COLUMN_WIDTH;
    // A column shorter than the tallest is centred, so the company sits mid-page.
    const top = MARGIN + ((tallest - column.length) * (NODE_HEIGHT + ROW_GAP)) / 2;
    column.forEach((n, i) => {
      nodes.push({
        ...n,
        x,
        y: top + i * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    });
  }
  return {
    title: t('title'),
    legend: [
      `▭ ${t('company')}`,
      `▢ ${t('processor')}`,
      `◌ ${t('sub')}`,
      t('cycle'),
      ...(omitted > 0 ? [t('omitted', { n: String(omitted) })] : []),
    ],
    nodes,
    edges: edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to)),
    width: MARGIN * 2 + (levels.length - 1) * COLUMN_WIDTH + NODE_WIDTH,
    height,
    omitted,
    generatedAt: input.generatedAt.toISOString().slice(0, 10),
    locale: input.locale,
  };
}

const INK = '#111111';
const MUTED = '#555555';
const PAPER = '#ffffff';
const FILL = { 0: '#e6e6e6', 1: '#ffffff', 2: '#f4f4f4', 3: '#f4f4f4' } as Record<number, string>;

const edgePath = (a: MapNode, b: MapNode): string => {
  const x1 = a.x + a.width;
  const y1 = a.y + a.height / 2;
  const x2 = b.x;
  const y2 = b.y + b.height / 2;
  if (b.level <= a.level) {
    // A cycle: out of the right side, around, and back into the target's right side.
    const bx = Math.max(x1, b.x + b.width) + 30;
    return `M ${x1} ${y1} C ${bx} ${y1}, ${bx} ${y2}, ${b.x + b.width} ${y2}`;
  }
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
};

export function supplyChainSvg(model: MapModel): string {
  const t = (k: string) => localise(WORDS[k]!, model.locale).value;
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}" role="img" aria-label="${esc(model.title)}" font-family="Helvetica, Arial, sans-serif" data-nodes="${model.nodes.length}" data-edges="${model.edges.length}" data-omitted="${model.omitted}">`,
  );
  lines.push(`<title>${esc(model.title)}</title>`);
  lines.push(
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${INK}"/></marker></defs>`,
  );
  lines.push(`<rect width="100%" height="100%" fill="${PAPER}"/>`);
  for (const e of model.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    lines.push(
      `<path d="${edgePath(a, b)}" fill="none" stroke="${INK}" stroke-width="1.2"${e.cycle ? ' stroke-dasharray="6 4"' : ''} marker-end="url(#arrow)" data-edge="${esc(e.from)}→${esc(e.to)}" data-cycle="${e.cycle}"/>`,
    );
  }
  for (const n of model.nodes) {
    const shape =
      n.level === 0
        ? `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" fill="${FILL[0]}" stroke="${INK}" stroke-width="2"/><rect x="${n.x + 3}" y="${n.y + 3}" width="${n.width - 6}" height="${n.height - 6}" fill="none" stroke="${INK}" stroke-width="1"/>`
        : n.level === 1
          ? `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" fill="${FILL[1]}" stroke="${INK}" stroke-width="1.5"/>`
          : `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="12" fill="${FILL[n.level] ?? FILL[3]}" stroke="${INK}" stroke-width="1" stroke-dasharray="${n.level >= 3 ? '2 3' : '4 3'}"/>`;
    const country = n.country ?? t('unknown');
    const text = `<text x="${n.x + 10}" y="${n.y + 18}" font-size="12" fill="${INK}">${esc(n.label)}</text><text x="${n.x + 10}" y="${n.y + 34}" font-size="10" fill="${MUTED}">${esc(country)}</text>`;
    const group = `<g data-node="${esc(n.id)}" data-level="${n.level}" data-jurisdiction="${esc(n.country ?? '')}"${n.evidenceId ? ` data-evidence="${esc(n.evidenceId)}"` : ''}>${shape}${text}</g>`;
    lines.push(
      n.href ? `<a xlink:href="${esc(n.href)}" href="${esc(n.href)}">${group}</a>` : group,
    );
  }
  const legendY = model.height - 14;
  lines.push(
    `<text x="${MARGIN}" y="${legendY}" font-size="10" fill="${MUTED}">${esc(model.legend.join('   ·   '))}   ·   ${esc(t('generated'))} ${model.generatedAt}</text>`,
  );
  lines.push('</svg>');
  return lines.join('\n');
}

export interface MapPdfOptions {
  readonly compress?: boolean;
}

// The same model on paper: landscape A4, scaled to fit, black and greys, the legend
// and the disclaimer at the foot. Nothing depends on the clock.
export function supplyChainPdf(model: MapModel, options: MapPdfOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 36,
      compress: options.compress ?? true,
      info: { Title: model.title, Producer: 'GDPRcompliant.eu', CreationDate: new Date(0) },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(model.title);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(`${localise(WORDS['generated']!, model.locale).value} ${model.generatedAt}`);
    const top = doc.y + 12;
    const availableW = doc.page.width - 72;
    const availableH = doc.page.height - top - 70;
    const scale = Math.min(1, availableW / model.width, availableH / (model.height - 30));
    doc.save();
    doc.translate(36, top).scale(scale);
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    for (const e of model.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      doc.path(edgePath(a, b)).lineWidth(1.2).strokeColor(INK);
      if (e.cycle) doc.dash(6, { space: 4 });
      doc.stroke();
      doc.undash();
      // The arrowhead, at the end of the path.
      const tx = b.level <= a.level ? b.x + b.width : b.x;
      const ty = b.y + b.height / 2;
      const dir = b.level <= a.level ? 1 : -1;
      doc
        .moveTo(tx, ty)
        .lineTo(tx + dir * 8, ty - 4)
        .lineTo(tx + dir * 8, ty + 4)
        .closePath()
        .fillColor(INK)
        .fill();
    }
    for (const n of model.nodes) {
      doc.lineWidth(n.level === 0 ? 2 : n.level === 1 ? 1.5 : 1).strokeColor(INK);
      if (n.level >= 2) doc.dash(n.level >= 3 ? 2 : 4, { space: 3 });
      if (n.level >= 2) doc.roundedRect(n.x, n.y, n.width, n.height, 12);
      else doc.rect(n.x, n.y, n.width, n.height);
      doc.fillColor(FILL[n.level] ?? '#f4f4f4').fillAndStroke();
      doc.undash();
      if (n.level === 0)
        doc
          .rect(n.x + 3, n.y + 3, n.width - 6, n.height - 6)
          .lineWidth(1)
          .stroke();
      doc
        .font('Helvetica')
        .fontSize(11)
        .fillColor(INK)
        .text(n.label, n.x + 10, n.y + 8, { width: n.width - 20, lineBreak: false });
      doc
        .fontSize(9)
        .fillColor(MUTED)
        .text(n.country ?? localise(WORDS['unknown']!, model.locale).value, n.x + 10, n.y + 24, {
          width: n.width - 20,
          lineBreak: false,
        });
    }
    doc.restore();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED);
    doc.text(model.legend.join('   ·   '), 36, doc.page.height - 60, {
      width: doc.page.width - 72,
    });
    doc.text(disclaimerText(model.locale), 36, doc.page.height - 46, {
      width: doc.page.width - 72,
    });
    doc.end();
  });
}

// Greys only: a colour whose channels differ is not one the map may use.
export const isGrey = (colour: string): boolean => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
  return m !== null && m[1] === m[2] && m[2] === m[3];
};

// The boxes never touch: legibility, checked rather than hoped for.
export function overlappingNodes(model: MapModel): [string, string][] {
  const out: [string, string][] = [];
  const n = model.nodes;
  for (let i = 0; i < n.length; i++) {
    for (let j = i + 1; j < n.length; j++) {
      const a = n[i]!;
      const b = n[j]!;
      const apart =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y;
      if (!apart) out.push([a.id, b.id]);
    }
  }
  return out;
}
