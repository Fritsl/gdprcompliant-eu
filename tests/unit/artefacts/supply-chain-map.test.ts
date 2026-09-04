import { describe, expect, it } from 'vitest';
import {
  MAP_MAX_NODES,
  isGrey,
  layoutSupplyChain,
  overlappingNodes,
  supplyChainPdf,
  supplyChainSvg,
  type MapInput,
  type ProcessorInput,
  type SubProcessorRow,
} from '@gc/artefacts';

// The supply-chain map without a database (D-08): three levels and sixty nodes laid
// out without a box touching another, every node carrying its country and the link to
// the evidence that placed it, nothing but greys in the drawing, a cycle dashed, the
// cap kept and announced, and a PDF from the same model.

const T0 = new Date('2026-09-05T09:14:00Z');
const row = (name: string) =>
  ({
    activityId: `node:activity:${name}`,
    key: `activity:${name}`,
    name,
    attributes: {},
    purposes: [],
    dataCategories: [],
    legalBases: [],
    recipients: [],
    transfers: [],
    risks: [],
    controls: [],
    origin: 'derived' as const,
    confidence: 0.6,
    evidence: [],
    draft: false,
    contradictions: 0,
  }) as const;

function chain(processors: number, subsEach: number, subSubsEach: number): MapInput {
  const procs: (ProcessorInput & { evidenceId?: string })[] = [];
  const subs: SubProcessorRow[] = [];
  for (let p = 0; p < processors; p++) {
    const pid = `node:vendor:p${p}`;
    procs.push({
      nodeId: pid,
      key: `vendor:host:p${p}.test`,
      name: `Processor ${p} A/S`,
      country: p % 3 === 0 ? 'DK' : p % 3 === 1 ? 'DE' : 'US',
      activities: [row('newsletter')],
      evidenceId: `registry_record:p${p}`,
    });
    for (let s = 0; s < subsEach; s++) {
      const sid = `node:vendor:p${p}s${s}`;
      subs.push({
        nodeId: sid,
        name: `Sub ${p}.${s} GmbH with a rather long company name`,
        country: 'IE',
        engagedBy: {
          nodeId: `node:vendor:chain-p${p}`,
          name: `Processor ${p} A/S`,
          key: `vendor:host:p${p}.test`,
        },
        source: `https://p${p}.test/sub-processors`,
        readOn: '2026-09-03T02:00:00Z',
        evidenceId: `document:list-p${p}`,
        level: 2,
      });
      for (let x = 0; x < subSubsEach; x++) {
        subs.push({
          nodeId: `node:vendor:p${p}s${s}x${x}`,
          name: `Deep ${p}.${s}.${x} Inc.`,
          engagedBy: { nodeId: sid, name: `Sub ${p}.${s} GmbH` },
          source: `https://p${p}s${s}.test/sub-processors`,
          readOn: '2026-09-03T02:01:00Z',
          evidenceId: `document:list-p${p}s${s}`,
          level: 3,
        });
      }
    }
  }
  return {
    company: { domain: 'eksempelbutik.dk', name: 'Eksempelbutik ApS', country: 'DK' },
    processors: procs,
    subProcessors: subs,
    locale: 'en',
    generatedAt: T0,
    evidenceHref: (id) => `#evidence-${id}`,
  };
}

describe('the layout', () => {
  it('draws three levels and sixty nodes without a box touching another, and says what it left off', () => {
    // 1 company + 6 processors + 18 sub-processors + 36 deeper = 61: one over the cap.
    const model = layoutSupplyChain(chain(6, 3, 2));
    expect(model.nodes).toHaveLength(MAP_MAX_NODES);
    expect(model.omitted).toBe(1);
    expect(new Set(model.nodes.map((n) => n.level))).toEqual(new Set([0, 1, 2, 3]));
    expect(overlappingNodes(model)).toEqual([]);
    for (const n of model.nodes) {
      expect(n.x + n.width).toBeLessThanOrEqual(model.width);
      expect(n.y + n.height).toBeLessThanOrEqual(model.height);
      expect(n.label.length).toBeLessThanOrEqual(27);
    }
    for (const e of model.edges) {
      expect(model.nodes.some((n) => n.id === e.from)).toBe(true);
      expect(model.nodes.some((n) => n.id === e.to)).toBe(true);
    }
    expect(model.legend.at(-1)).toBe('1 more not drawn');
    // A page-sized drawing: wide enough for four columns, no taller than it must be.
    expect(model.width).toBeLessThan(1100);
    expect(model.height).toBeLessThan(36 * 58 + 120);
  });

  it('places every node with its country and the evidence that put it there, and keeps a cycle as a dashed edge', () => {
    const input = chain(2, 1, 1);
    const withCycle: MapInput = {
      ...input,
      subProcessors: [
        ...input.subProcessors,
        {
          nodeId: 'node:vendor:p0',
          name: 'Processor 0 A/S',
          engagedBy: { nodeId: 'node:vendor:p0s0', name: 'Sub 0.0 GmbH' },
          source: 'https://p0s0.test/sub-processors',
          readOn: '2026-09-03T02:02:00Z',
          evidenceId: 'document:list-p0s0',
          level: 3,
        },
      ],
    };
    const model = layoutSupplyChain(withCycle);
    const svg = supplyChainSvg(model);
    for (const n of model.nodes.filter((n) => n.level > 0)) {
      expect(n.evidenceId, n.id).toBeDefined();
      expect(n.href).toBe(`#evidence-${n.evidenceId}`);
      expect(svg).toContain(
        `data-node="${n.id}" data-level="${n.level}" data-jurisdiction="${n.country ?? ''}" data-evidence="${n.evidenceId}"`,
      );
      expect(svg).toContain(`href="#evidence-${n.evidenceId}"`);
    }
    expect(svg).toContain('data-jurisdiction="DK"');
    expect(svg).toContain('data-jurisdiction="DE"');
    expect(svg).toContain('data-jurisdiction=""');
    const cycles = model.edges.filter((e) => e.cycle);
    expect(cycles).toEqual([{ from: 'node:vendor:p0s0', to: 'node:vendor:p0', cycle: true }]);
    expect(svg).toMatch(
      /stroke-dasharray="6 4" marker-end="url\(#arrow\)" data-edge="node:vendor:p0s0→node:vendor:p0" data-cycle="true"/,
    );
    expect(svg).toContain('data-nodes="7"');
  });

  it('uses greys only, so the map reads the same printed in greyscale, and tells levels by shape', () => {
    const svg = supplyChainSvg(layoutSupplyChain(chain(3, 2, 1)));
    const colours = [...svg.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/gi)].map((m) => m[1]!);
    expect(colours.length).toBeGreaterThan(10);
    for (const c of colours) expect(isGrey(c), c).toBe(true);
    expect(svg).not.toMatch(/(?:fill|stroke)="(?:red|blue|green|orange|url\(#[^a])/);
    // The company is double-bordered, a processor a plain box, a sub-processor rounded and dashed.
    expect(svg).toMatch(/stroke-width="2"\/><rect [^>]*stroke-width="1"\/>/);
    expect(svg).toMatch(/rx="12"[^>]*stroke-dasharray="4 3"/);
    expect(svg).toMatch(/rx="12"[^>]*stroke-dasharray="2 3"/);
    expect(isGrey('#ff0000')).toBe(false);
  });

  it('reads in Danish and German, and draws the same model to a PDF', async () => {
    const da = layoutSupplyChain({ ...chain(1, 1, 0), locale: 'da' });
    expect(da.title).toBe('Leverandørkæde');
    expect(supplyChainSvg(da)).toContain('Udarbejdet 2026-09-05');
    const de = layoutSupplyChain({ ...chain(1, 1, 0), locale: 'de' });
    expect(de.legend[0]).toBe('▭ das Unternehmen');
    const pdf = await supplyChainPdf(layoutSupplyChain(chain(6, 3, 2)), { compress: false });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdf.toString('latin1');
    expect(text).toContain('(GDPRcompliant.eu)');
    expect(text).toContain('(D:19700101000000Z)');
    // Landscape A4, and every colour operator grey (equal r, g, b).
    expect(text).toMatch(/MediaBox \[0 0 841\.89 595\.28\]/);
    const rgb = [
      ...text.matchAll(/(\d\.\d+|\d) (\d\.\d+|\d) (\d\.\d+|\d) (?:rg|RG|scn|SCN|sc|SC)\b/g),
    ];
    expect(rgb.length).toBeGreaterThan(5);
    for (const m of rgb) expect(m[1] === m[2] && m[2] === m[3], m[0]).toBe(true);
  });
});
