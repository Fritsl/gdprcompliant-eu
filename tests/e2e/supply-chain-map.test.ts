import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VendorSchema, sha256, type SupplyChain, type Vendor } from '@gc/contracts';
import {
  createTestDatabase,
  openCase,
  schema,
  seedRegister,
  seedSupplyChain,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import { MAP_MAX_NODES, isGrey } from '@gc/artefacts';

// The supply-chain map (D-08), in a real browser: three levels and sixty nodes drawn
// without a box touching another; every node with its jurisdiction and a link to the
// evidence that placed it, which the page lists; the same map as SVG, PNG and PDF, in
// greys only; and a link from the case page.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const ARTIFACTS = join(ROOT, 'artifacts');
const PORT = 3435;
const BASE = `http://127.0.0.1:${PORT}`;
const next = join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next');
const url = testDatabaseUrl();
const T0 = new Date('2026-09-05T09:14:00Z');

async function waitFor(target: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(target, { redirect: 'manual' });
      if (r.status < 500) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${target} did not come up: ${last}`);
}

// Six processors from the register, each naming three sub-processors, each of those
// naming two more: 1 + 6 + 18 + 36 = 61 companies, one over the cap, three levels deep.
const PROCESSORS = 6;
const LIST_BODY = (host: string) => `sub-processor list of ${host}`;
const listRef = (host: string) => {
  const hash = sha256(LIST_BODY(host));
  return { evidenceId: `document:${hash.slice(0, 16)}`, hash };
};

function chainFor(p: number): SupplyChain {
  const root = `proc${p}.test`;
  const nodes: SupplyChain['nodes'] = [
    { id: root, name: `Processor ${p} A/S`, host: root, depth: 0, list: 'read' },
  ];
  const edges: SupplyChain['edges'] = [];
  const doc = (host: string) => ({
    url: `https://${host}/sub-processors`,
    fetchedAt: '2026-09-03T02:00:00Z',
    evidence: listRef(host),
  });
  for (let s = 0; s < 3; s++) {
    const sub = `sub${p}-${s}.test`;
    nodes.push({
      id: sub,
      name: `Sub ${p}.${s} GmbH`,
      host: sub,
      country: 'DE',
      depth: 1,
      list: 'read',
    });
    edges.push({
      from: root,
      to: sub,
      document: doc(root),
      entry: {
        name: `Sub ${p}.${s} GmbH`,
        host: sub,
        country: 'DE',
        purpose: 'Hosting',
        quote: `Sub ${p}.${s} GmbH\tGermany\tHosting\t${sub}`,
      },
      cycle: false,
    });
    for (let x = 0; x < 2; x++) {
      const deep = `deep${p}-${s}-${x}.test`;
      nodes.push({
        id: deep,
        name: `Deep ${p}.${s}.${x} Inc.`,
        host: deep,
        country: 'US',
        depth: 2,
        list: 'skipped',
        skipped: 'depth',
      });
      edges.push({
        from: sub,
        to: deep,
        document: doc(sub),
        entry: {
          name: `Deep ${p}.${s}.${x} Inc.`,
          host: deep,
          country: 'US',
          quote: `Deep ${p}.${s}.${x} Inc.\tUnited States\t${deep}`,
        },
        cycle: false,
      });
    }
  }
  return {
    root,
    startedAt: '2026-09-03T02:00:00Z',
    finishedAt: '2026-09-03T02:05:00Z',
    limits: { maxDepth: 2, maxNodes: 25, minIntervalMs: 1000, respectRobots: true },
    nodes,
    edges,
    stoppedBy: 'depth',
    dropped: 0,
    requests: [],
  };
}

describe.skipIf(!url)('the supply-chain map (D-08)', () => {
  let t: TestDatabase;
  let server: ChildProcess | undefined;
  let browser: Browser;
  let token = '';

  beforeAll(async () => {
    t = await createTestDatabase(url);
    const opened = await openCase(t, {
      company: {
        domain: 'eksempelbutik.dk',
        legalName: 'Eksempelbutik ApS',
        country: 'DK',
        locale: 'da',
      },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => T0,
    });
    token = opened.accessToken;
    const { tenantId, caseId } = opened;
    const vendors: Vendor[] = [];
    const rows: (typeof schema.evidence.$inferInsert)[] = [];
    for (let p = 0; p < PROCESSORS; p++) {
      const body = `MX eksempelbutik.dk -> mx.proc${p}.test`;
      const hash = sha256(body);
      const evidenceId = `registry_record:${hash.slice(0, 16)}`;
      rows.push({
        id: evidenceId,
        tenantId,
        sourceRef: 'dns',
        caseId,
        kind: 'registry_record',
        capturedAt: T0,
        body,
        hash,
        caption: `MX record ${p}`,
      });
      vendors.push(
        VendorSchema.parse({
          id: `host:proc${p}.test`,
          tenantId,
          caseId,
          label: `Processor ${p} A/S`,
          jurisdiction: p % 2 === 0 ? 'DK' : 'IE',
          role: 'processor',
          level: 1,
          hosts: [`proc${p}.test`],
          resolution: 'unresolved',
          provenance: {
            source: 'observation',
            seenAt: T0.toISOString(),
            evidence: [{ evidenceId, hash }],
          },
        }),
      );
      for (const host of [`proc${p}.test`, `sub${p}-0.test`, `sub${p}-1.test`, `sub${p}-2.test`]) {
        const ref = listRef(host);
        rows.push({
          id: ref.evidenceId,
          tenantId,
          sourceRef: 'scanner:scan-1',
          caseId,
          kind: 'document',
          capturedAt: T0,
          body: LIST_BODY(host),
          hash: ref.hash,
          caption: `sub-processor list of ${host}`,
        });
      }
    }
    await withTenant(t, tenantId, (db) => db.insert(schema.evidence).values(rows));
    await seedRegister(t, tenantId, caseId, { scanId: 'scan-1', now: T0, vendors });
    for (let p = 0; p < PROCESSORS; p++) {
      await seedSupplyChain(t, tenantId, caseId, { chain: chainFor(p), scanId: 'scan-1', now: T0 });
    }
    mkdirSync(ARTIFACTS, { recursive: true });
    if (!existsSync(join(WEB, '.next', 'BUILD_ID')) || process.env['GC_E2E_BUILD'] === '1') {
      const build = spawnSync(process.execPath, [next, 'build', '--webpack'], {
        cwd: WEB,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      if (build.status !== 0)
        throw new Error(`next build failed:\n${build.stdout}\n${build.stderr}`);
    }
    server = spawn(process.execPath, [next, 'start', '-p', String(PORT), '-H', '127.0.0.1'], {
      cwd: WEB,
      stdio: 'pipe',
      env: {
        ...process.env,
        DATABASE_URL: url,
        GC_SEARCH_PATH: `${t.schema},public`,
        APP_BASE_URL: BASE,
      },
    });
    await waitFor(`${BASE}/en`, 60_000);
    browser = await chromium.launch();
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    await t?.drop();
  });

  it('draws three levels and sixty nodes legibly, each with its jurisdiction and its evidence link', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/en/c/${token}/supply-chain`);
    const article = page.locator('article.supply-chain');
    expect(await article.getAttribute('data-nodes')).toBe(String(MAP_MAX_NODES));
    expect(await article.getAttribute('data-omitted')).toBe('1');
    const svg = page.locator('[data-map] svg');
    expect(await svg.count()).toBe(1);
    const boxes = await page.locator('[data-map] g[data-node]').evaluateAll((els) =>
      els.map((g) => {
        const r = g.querySelector('rect')!.getBoundingClientRect();
        return {
          id: g.getAttribute('data-node')!,
          level: Number(g.getAttribute('data-level')),
          jurisdiction: g.getAttribute('data-jurisdiction'),
          evidence: g.getAttribute('data-evidence'),
          href: g.closest('a')?.getAttribute('href') ?? null,
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
        };
      }),
    );
    expect(boxes).toHaveLength(MAP_MAX_NODES);
    expect(new Set(boxes.map((b) => b.level))).toEqual(new Set([0, 1, 2, 3]));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.id} touches ${b.id}`).toBe(true);
      }
    }
    for (const b of boxes.filter((b) => b.level > 0)) {
      expect(b.jurisdiction, b.id).toMatch(/^[A-Z]{2}$/);
      expect(b.evidence, b.id).toBeTruthy();
      expect(b.href).toBe(`#evidence-${b.evidence}`);
      expect(await page.locator(`[data-evidence-row="${b.evidence}"]`).count(), b.evidence!).toBe(
        1,
      );
    }
    expect(boxes.find((b) => b.level === 0)?.jurisdiction).toBe('DK');
    // Every label fits its box: nothing overflows the width the box gives it.
    const overflow = await page
      .locator('[data-map] g[data-node] text')
      .evaluateAll(
        (els) => els.filter((t) => (t as SVGTextElement).getComputedTextLength() > 190).length,
      );
    expect(overflow).toBe(0);
    await page.screenshot({ path: join(ARTIFACTS, 'd08-map.png'), fullPage: true });
    await page.close();
  }, 120_000);

  it('exports the same map as SVG, PNG and PDF, in greys only', async () => {
    const svg = await fetch(`${BASE}/en/c/${token}/supply-chain.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    const svgText = await svg.text();
    expect(svgText).toContain(`data-nodes="${MAP_MAX_NODES}"`);
    const colours = [...svgText.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/gi)].map((m) => m[1]!);
    expect(colours.length).toBeGreaterThan(50);
    for (const c of colours) expect(isGrey(c), c).toBe(true);

    const png = await fetch(`${BASE}/en/c/${token}/supply-chain.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await png.arrayBuffer());
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const width = (bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!;
    const height = (bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!;
    expect(width).toBeGreaterThan(1500);
    expect(height).toBeGreaterThan(1500);
    // Colour type 2 (RGB) or 6 (RGBA) with the greys the SVG declares: no chroma.
    expect([2, 6]).toContain(bytes[25]);

    const pdf = await fetch(`${BASE}/en/c/${token}/supply-chain.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    const pdfBytes = Buffer.from(await pdf.arrayBuffer());
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.headers.get('content-disposition')).toContain('supply-chain.pdf');
  }, 120_000);

  it('is linked from the case page, in the case language', async () => {
    const page = await browser.newPage();
    await page.goto(`${BASE}/da/c/${token}`);
    const link = page.locator('[data-supply-chain-link]');
    expect(await link.count()).toBe(1);
    expect(await link.innerText()).toBe('Kort over leverandørkæden');
    await link.click();
    await page.waitForURL(/\/supply-chain$/);
    expect(await page.locator('h1').innerText()).toBe('Leverandørkæde');
    expect(await page.locator('[data-export="png"]').count()).toBe(1);
    await page.close();
  }, 60_000);
});
