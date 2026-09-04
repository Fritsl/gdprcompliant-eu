import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupplyChainSchema, sha256, type VendorRegistryEntry } from '@gc/contracts';
import {
  createTestDatabase,
  openCase,
  seedSupplyChain,
  supplyChainOf,
  testDatabaseUrl,
  withTenant,
  type TestDatabase,
} from '@gc/db';
import {
  BrowserPool,
  FixtureServer,
  loadFixtureSites,
  parseSubProcessorEntries,
  robotsAllows,
  traverseSupplyChain,
  type FixtureHost,
} from '@gc/scanner';

// Sub-processor recursion (D-07) over a synthetic supply chain: a supplier's list names
// three companies, two of which publish lists of their own, one of which names the
// supplier back. Along the way: a host whose robots.txt refuses everyone, a host whose
// robots.txt refuses the list's path, a host with no list, a company with no site, and
// a chain deep enough to hit the depth cap. The caps, the cycle, the document and date
// on every edge, and the one-request-per-host-per-interval record are each checked;
// then the chain is written to the case graph and read back.

const identity = {
  tenantId: 't-1',
  caseId: 'DK-26-0M4K',
  scanId: 'scan-1',
  capturedAt: '2026-09-04T09:14:00Z',
};
const root = mkdtempSync(join(tmpdir(), 'subprocessors-'));

const page = (title: string, body: string, lang = 'en') =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const list = (title: string, rows: string[][]) =>
  page(
    title,
    `<h1>${title}</h1><p>The companies below process personal data on our behalf.</p><table>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('')}</table>`,
  );

function host(name: string, files: Record<string, string>): FixtureHost {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return { host: name, dir, routes: [] };
}

const hosts: FixtureHost[] = [
  host('sp0.test', {
    'index.html': page(
      'Sendmore',
      `<main>Email for everyone.</main><footer><a href="/privacy">Privacy</a> <a href="/legal/sub-processors">Sub-processors</a></footer>`,
    ),
    'legal/sub-processors/index.html': list('Sendmore sub-processors', [
      ['Alpha Hosting GmbH', 'Germany', 'Hosting of the platform', 'alpha-hosting.test'],
      ['Beta Mail Inc.', 'United States', 'Email delivery', 'beta-mail.test'],
      ['Gamma Analytics ApS', 'Denmark', 'Product analytics'],
    ]),
    'privacy/index.html': page('Privacy', '<p>privacy</p>'),
  }),
  host('alpha-hosting.test', {
    'index.html': page('Alpha Hosting', `<main>Rechenzentren in Frankfurt.</main>`, 'de'),
    'sub-processors/index.html': list('Unterauftragsverarbeiter', [
      ['Delta Storage B.V.', 'Niederlande', 'Objektspeicher', 'delta-storage.test'],
      ['Sendmore ApS', 'Dänemark', 'Transaktionale E-Mails', 'sp0.test'],
    ]),
  }),
  host('beta-mail.test', {
    'index.html': page(
      'Beta Mail',
      `<footer><a href="/vendors">Third-party service providers</a></footer>`,
    ),
    'vendors/index.html': list('Third-party service providers', [
      ['Epsilon Cloud LLC', 'United States', 'Infrastructure', 'epsilon-cloud.test'],
      ['Zeta Security Ltd', 'United Kingdom', 'Security monitoring', 'zeta-security.test'],
      ['Theta Support Oy', 'Finland', 'Support tooling', 'theta-support.test'],
    ]),
  }),
  host('delta-storage.test', {
    'robots.txt': 'User-agent: *\nDisallow: /\n',
    'index.html': page(
      'Delta Storage',
      `<footer><a href="/sub-processors">Sub-processors</a></footer>`,
    ),
    'sub-processors/index.html': list('Sub-processors', [
      ['Iota DNS Inc.', 'United States', 'DNS', 'iota-dns.test'],
    ]),
  }),
  host('epsilon-cloud.test', {
    'robots.txt': 'User-agent: *\nDisallow: /legal/\n',
    'index.html': page(
      'Epsilon Cloud',
      `<footer><a href="/legal/sub-processors">Sub-processors</a></footer>`,
    ),
    'legal/sub-processors/index.html': list('Sub-processors', [
      ['Kappa Networks Inc.', 'United States', 'Networking', 'kappa-networks.test'],
    ]),
  }),
  host('zeta-security.test', {
    'index.html': page(
      'Zeta Security',
      `<footer><a href="/legal/subprocessors">Subprocessors</a></footer>`,
    ),
    'legal/subprocessors/index.html': list('Subprocessors', [
      ['Eta Backup AB', 'Sweden', 'Backups', 'eta-backup.test'],
    ]),
  }),
  host('theta-support.test', {
    'index.html': page(
      'Theta Support',
      `<main>Support desks.</main><footer><a href="/about">About</a></footer>`,
    ),
    'about/index.html': page('About', '<p>Helsinki.</p>'),
  }),
  host('eta-backup.test', {
    'index.html': page(
      'Eta Backup',
      `<footer><a href="/sub-processors">Sub-processors</a></footer>`,
    ),
    'sub-processors/index.html': list('Sub-processors', [
      ['Lambda Tapes AB', 'Sweden', 'Off-site tapes', 'lambda-tapes.test'],
    ]),
  }),
];

const sites = loadFixtureSites();
let server: FixtureServer;
let pool: BrowserPool;
const T0 = new Date('2026-09-04T09:14:00Z');

beforeAll(async () => {
  server = await new FixtureServer([...sites.flatMap((s) => s.hosts), ...hosts]).start();
  pool = await new BrowserPool({
    concurrency: 2,
    passTimeoutMs: 60_000,
    navigationTimeoutMs: 10_000,
    launch: { proxy: { server: server.proxy } },
    ignoreHTTPSErrors: true,
  }).start();
});

afterAll(async () => {
  await pool?.stop();
  await server?.stop();
});

const walk = (limits: Record<string, number | boolean> = {}) =>
  traverseSupplyChain(
    pool,
    { url: 'http://sp0.test/' },
    { identity, vendorName: 'Sendmore', limits: { minIntervalMs: 300, ...limits } },
  );

describe('reading a list', () => {
  it('names the companies on a page, with site, country and purpose where the line gives them', () => {
    const text = [
      'Sub-processors',
      'The companies below process personal data on our behalf.',
      'Alpha Hosting GmbH\tGermany\tHosting of the platform\talpha-hosting.test',
      'Beta Mail Inc. | United States | Email delivery',
      'Gamma Analytics ApS – Denmark',
      'Updated 2026-09-01',
    ].join('\n');
    const links = [{ href: 'https://beta-mail.test/', text: 'Beta Mail Inc.', inFooter: false }];
    const entries = parseSubProcessorEntries({ text, links }, 'sp0.test');
    expect(entries.map((e) => [e.name, e.host, e.country, e.purpose])).toEqual([
      ['Alpha Hosting GmbH', 'alpha-hosting.test', 'DE', 'Hosting of the platform'],
      ['Beta Mail Inc', 'beta-mail.test', 'US', 'Email delivery'],
      ['Gamma Analytics ApS', undefined, 'DK', undefined],
    ]);
    expect(entries[0]!.quote).toBe(
      'Alpha Hosting GmbH\tGermany\tHosting of the platform\talpha-hosting.test',
    );
  });

  it('reads robots.txt for our group or everyone, longest rule first', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /', '/legal/dpa')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /legal/', '/legal/sub-processors')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /legal/', '/sub-processors')).toBe(true);
    expect(
      robotsAllows(
        'User-agent: *\nDisallow: /legal/\nAllow: /legal/sub-processors',
        '/legal/sub-processors',
      ),
    ).toBe(true);
    expect(
      robotsAllows('User-agent: gdprcompliant\nDisallow: /\n\nUser-agent: *\nDisallow:', '/'),
    ).toBe(false);
    expect(robotsAllows('User-agent: otherbot\nDisallow: /', '/')).toBe(true);
    expect(robotsAllows('', '/anything')).toBe(true);
  });
});

describe('the walk (D-07)', () => {
  it('follows the lists breadth first, keeps a cycle as an edge, and stops at the depth cap', async () => {
    const { chain, lists, evidence } = await walk();
    expect(() => SupplyChainSchema.parse(chain)).not.toThrow();
    expect(chain.root).toBe('sp0.test');
    expect(chain.limits).toEqual({
      maxDepth: 3,
      maxNodes: 25,
      minIntervalMs: 300,
      respectRobots: true,
    });
    const byId = new Map(chain.nodes.map((n) => [n.id, n]));
    expect(byId.get('sp0.test')).toMatchObject({ depth: 0, list: 'read', name: 'Sendmore' });
    expect(byId.get('alpha-hosting.test')).toMatchObject({ depth: 1, list: 'read', country: 'DE' });
    expect(byId.get('beta-mail.test')).toMatchObject({ depth: 1, list: 'read', country: 'US' });
    expect(byId.get('name:gamma-analytics-aps')).toMatchObject({
      depth: 1,
      list: 'skipped',
      skipped: 'no_site',
    });
    expect(byId.get('delta-storage.test')).toMatchObject({
      depth: 2,
      list: 'skipped',
      skipped: 'robots',
    });
    expect(byId.get('epsilon-cloud.test')).toMatchObject({
      depth: 2,
      list: 'skipped',
      skipped: 'robots',
    });
    expect(byId.get('theta-support.test')).toMatchObject({
      depth: 2,
      list: 'skipped',
      skipped: 'no_list',
    });
    expect(byId.get('zeta-security.test')).toMatchObject({ depth: 2, list: 'read' });
    // Depth 3 is on the chain but its list is never read; nothing beyond it exists.
    expect(byId.get('eta-backup.test')).toMatchObject({
      depth: 3,
      list: 'skipped',
      skipped: 'depth',
    });
    expect(byId.has('lambda-tapes.test')).toBe(false);
    expect(byId.has('kappa-networks.test')).toBe(false);
    expect(byId.has('iota-dns.test')).toBe(false);
    expect(chain.stoppedBy).toBe('depth');
    expect(chain.nodes).toHaveLength(9);

    // The cycle: alpha names the supplier the walk started from.
    const cycle = chain.edges.find((e) => e.from === 'alpha-hosting.test' && e.to === 'sp0.test');
    expect(cycle?.cycle).toBe(true);
    expect(chain.edges.filter((e) => e.cycle)).toHaveLength(1);
    // The supplier's own page was read once, before the cycle came up.
    expect(
      chain.requests.filter((r) => r.host === 'sp0.test' && r.url.includes('sub-processors')),
    ).toHaveLength(1);

    // Every edge carries the list it came from and when, and the list is stored evidence.
    expect(chain.edges).toHaveLength(9);
    for (const e of chain.edges) {
      expect(e.document.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(e.document.url).toContain(e.from);
      const row = evidence.find((x) => x.id === e.document.evidence.evidenceId)!;
      expect(row.hash).toBe(e.document.evidence.hash);
      expect(row.body).toContain(e.entry.quote);
      expect(row.caption).toContain('sub-processor list of');
    }
    expect(lists.map((l) => l.vendor.host).sort()).toEqual(
      ['alpha-hosting.test', 'beta-mail.test', 'sp0.test', 'zeta-security.test'].sort(),
    );
  }, 120_000);

  it('the node cap stops the walk and says so, counting what it left off', async () => {
    const { chain } = await walk({ maxNodes: 4 });
    expect(chain.nodes).toHaveLength(4);
    expect(chain.nodes.map((n) => n.id)).toEqual([
      'sp0.test',
      'alpha-hosting.test',
      'beta-mail.test',
      'name:gamma-analytics-aps',
    ]);
    expect(chain.stoppedBy).toBe('nodes');
    expect(chain.dropped).toBeGreaterThanOrEqual(3);
    // An edge only ever joins two nodes on the chain.
    for (const e of chain.edges) expect(chain.nodes.some((n) => n.id === e.to)).toBe(true);
    expect(() =>
      SupplyChainSchema.parse({ ...chain, limits: { ...chain.limits, maxNodes: 3 } }),
    ).toThrow();
  }, 120_000);

  it('a depth cap of one reads only the supplier, and keeps its sub-processors as leaves', async () => {
    const { chain } = await walk({ maxDepth: 1 });
    expect(chain.nodes.filter((n) => n.list === 'read').map((n) => n.id)).toEqual(['sp0.test']);
    expect(
      chain.nodes
        .filter((n) => n.skipped === 'depth')
        .map((n) => n.id)
        .sort(),
    ).toEqual(['alpha-hosting.test', 'beta-mail.test'].sort());
    expect(chain.stoppedBy).toBe('depth');
  }, 60_000);

  it('asks robots.txt once per host first, and never asks one host twice within the interval', async () => {
    const { chain } = await walk();
    const byHost = new Map<string, { url: string; at: number }[]>();
    for (const r of chain.requests) {
      const rows = byHost.get(r.host) ?? [];
      rows.push({ url: r.url, at: new Date(r.at).getTime() });
      byHost.set(r.host, rows);
    }
    expect(byHost.size).toBeGreaterThanOrEqual(7);
    for (const [h, rows] of byHost) {
      expect(rows[0]!.url, h).toBe(`http://${h}/robots.txt`);
      for (let i = 1; i < rows.length; i++) {
        expect(
          rows[i]!.at - rows[i - 1]!.at,
          `${h}: ${rows[i - 1]!.url} then ${rows[i]!.url}`,
        ).toBeGreaterThanOrEqual(290);
      }
    }
    // A host that refuses everyone got exactly one request: the question.
    expect(byHost.get('delta-storage.test')!.map((r) => r.url)).toEqual([
      'http://delta-storage.test/robots.txt',
    ]);
    // A host that refuses the list's path was asked for its home page and nothing under /legal/.
    expect(byHost.get('epsilon-cloud.test')!.some((r) => r.url.includes('/legal/'))).toBe(false);
  }, 120_000);

  it('with robots ignored, the refused host is read and the chain grows', async () => {
    const { chain } = await walk({ respectRobots: false });
    const delta = chain.nodes.find((n) => n.id === 'delta-storage.test');
    expect(delta).toMatchObject({ list: 'read' });
    expect(chain.nodes.some((n) => n.id === 'iota-dns.test')).toBe(true);
    expect(chain.requests.some((r) => r.url.endsWith('/robots.txt'))).toBe(false);
  }, 120_000);
});

const url = (() => {
  try {
    return testDatabaseUrl();
  } catch (e) {
    if (process.env['CI']) throw e;
    console.warn((e as Error).message);
    return undefined;
  }
})();

describe.skipIf(!url)('the chain on the case graph', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase(url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('writes a vendor node per company and an engages edge per list entry, with document and date', async () => {
    const opened = await openCase(t, {
      company: { domain: 'eksempelbutik.dk', country: 'DK', locale: 'da' },
      jurisdiction: 'DK',
      locale: 'da',
      now: () => T0,
    });
    const { chain, evidence } = await walk();
    const entry: VendorRegistryEntry = {
      id: 'beta-mail',
      label: 'Beta Mail (email delivery)',
      contracting: { name: 'Beta Mail Ireland Ltd', country: 'IE' },
      parent: { name: 'Beta Mail Inc.', country: 'US' },
      role: 'processor',
      hostSuffixes: ['beta-mail.test'],
      dnsServices: [],
      recipientHosts: [],
      provenance: { url: 'https://beta-mail.test/terms', verifiedAt: '2026-09-04T00:00:00Z' },
      reviewBy: '2027-03-04',
    };
    const seeded = await seedSupplyChain(t, opened.tenantId, opened.caseId, {
      chain,
      scanId: 'scan-1',
      now: T0,
      resolve: (h) =>
        h === 'beta-mail.test' ? { resolution: 'resolved', entry } : { resolution: 'unresolved' },
    });
    expect(seeded.nodes).toBe(chain.nodes.length);
    expect(seeded.edges).toBe(chain.edges.length);

    const rows = await withTenant(t, opened.tenantId, (db) => supplyChainOf(db, opened.caseId));
    expect(rows).toHaveLength(chain.edges.length);
    const keys = new Set(rows.flatMap((r) => [r.from.key, r.to.key]));
    expect(keys.has('vendor:beta-mail')).toBe(true);
    expect(keys.has('vendor:host:alpha-hosting.test')).toBe(true);
    expect(keys.has('vendor:name:gamma-analytics-aps')).toBe(true);
    const beta = rows.find((r) => r.to.key === 'vendor:beta-mail')!;
    expect(beta.to.attributes).toMatchObject({
      name: 'Beta Mail Ireland Ltd',
      country: 'IE',
      level: 2,
    });
    expect(beta.from.attributes).toMatchObject({ name: 'Sendmore', level: 1 });
    expect(beta.edge.kind).toBe('engages');
    expect(beta.edge.attributes).toMatchObject({
      document: 'http://sp0.test/legal/sub-processors',
      quote: 'Beta Mail Inc.\tUnited States\tEmail delivery\tbeta-mail.test',
      cycle: false,
    });
    expect(String(beta.edge.attributes['fetchedAt'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(beta.edge.evidence).toEqual([
      chain.edges.find((e) => e.to === 'beta-mail.test')!.document.evidence,
    ]);
    const listRow = evidence.find((e) => e.id === beta.edge.evidence[0]!.evidenceId)!;
    expect(sha256(listRow.body)).toBe(beta.edge.evidence[0]!.hash);
    const cycle = rows.find((r) => r.edge.attributes['cycle'] === true)!;
    expect(cycle.from.key).toBe('vendor:host:alpha-hosting.test');
    expect(cycle.to.key).toBe('vendor:host:sp0.test');
    // Seeding again is idempotent: the same facts from the same source are the same rows.
    const again = await seedSupplyChain(t, opened.tenantId, opened.caseId, {
      chain,
      scanId: 'scan-1',
      now: T0,
      resolve: (h) =>
        h === 'beta-mail.test' ? { resolution: 'resolved', entry } : { resolution: 'unresolved' },
    });
    expect(again.nodes).toBe(0);
    expect(
      await withTenant(t, opened.tenantId, (db) => supplyChainOf(db, opened.caseId)),
    ).toHaveLength(chain.edges.length);
  }, 120_000);
});
