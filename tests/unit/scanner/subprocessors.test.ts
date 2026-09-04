import { describe, expect, it } from 'vitest';
import { SupplyChainSchema } from '@gc/contracts';
import {
  DEFAULT_LIMITS,
  Politeness,
  countryIn,
  parseSubProcessorEntries,
  robotsAllows,
  scoreListLink,
  slug,
} from '@gc/scanner';

// Sub-processor lists without a browser (D-07): the entry parser over the shapes lists
// take in three languages, the link scorer, robots.txt as read for our agent, the
// per-host interval with an injected clock, and the chain contract's own rules.

describe('the entry parser', () => {
  it('reads a table, a bulleted list and prose lines, keeping the line verbatim', () => {
    const text = [
      'Underdatabehandlere',
      'Vi bruger følgende underdatabehandlere:',
      'Alpha Hosting GmbH\tTyskland\tHosting\talpha-hosting.test',
      '• Beta Mail Inc. (USA) – e-mailudsendelse',
      'Gamma Analytics ApS, Danmark, produktanalyse, gamma.test',
      'Kontakt os på privacy@example.test',
      '2026-09-01',
    ].join('\n');
    const entries = parseSubProcessorEntries({ text, links: [] }, 'www.example.test');
    expect(entries.map((e) => [e.name, e.host, e.country])).toEqual([
      ['Alpha Hosting GmbH', 'alpha-hosting.test', 'DE'],
      ['• Beta Mail Inc', undefined, 'US'],
      ['Gamma Analytics ApS', 'gamma.test', 'DK'],
    ]);
    expect(entries[0]!.purpose).toBe('Hosting');
    expect(entries[1]!.quote).toBe('• Beta Mail Inc. (USA) – e-mailudsendelse');
    // Its own host is never a sub-processor, and a contact line is not a company.
    expect(entries.some((e) => e.host === 'example.test')).toBe(false);
  });

  it('takes the site from an off-site link that carries the name, and never the same name twice', () => {
    const text =
      'Sub-processors\nDelta Storage B.V. – Netherlands\nDelta Storage B.V. – Netherlands\n';
    const links = [
      { href: 'https://www.delta-storage.test/', text: 'Delta Storage B.V.', inFooter: false },
      { href: 'https://example.test/about', text: 'Delta Storage B.V.', inFooter: false },
    ];
    const entries = parseSubProcessorEntries({ text, links }, 'example.test');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.host).toBe('www.delta-storage.test');
  });

  it('knows the countries lists name, in the languages they name them', () => {
    expect(countryIn('Frankfurt, Deutschland')).toBe('DE');
    expect(countryIn('Dublin, Irland')).toBe('IE');
    expect(countryIn('Vereinigte Staaten')).toBe('US');
    expect(countryIn('Storbritannien')).toBe('GB');
    expect(countryIn('nowhere in particular')).toBeUndefined();
  });

  it('scores a link by its words and its path, and slugs a name for a node id', () => {
    const link = (text: string, href: string, inFooter = true) => ({ href, text, inFooter });
    expect(scoreListLink(link('Sub-processors', 'https://x.test/legal/sub-processors'))).toBe(17);
    expect(scoreListLink(link('Unterauftragsverarbeiter', 'https://x.test/legal'))).toBe(12);
    expect(
      scoreListLink(link('Third-party service providers', 'https://x.test/vendors', false)),
    ).toBe(15);
    expect(scoreListLink(link('Privacy', 'https://x.test/privacy'))).toBe(0);
    expect(slug('Gamma Analytics ApS')).toBe('gamma-analytics-aps');
  });
});

describe('robots.txt', () => {
  it('applies the group for our agent over the group for everyone', () => {
    const robots =
      'User-agent: gdprcompliant\nAllow: /legal/\nDisallow: /\n\nUser-agent: *\nDisallow: /legal/\n';
    expect(robotsAllows(robots, '/legal/sub-processors')).toBe(true);
    expect(robotsAllows(robots, '/pricing')).toBe(false);
    expect(robotsAllows(robots, '/pricing', 'someone-else')).toBe(true);
  });

  it('ignores comments and unknown fields, and an empty Disallow allows everything', () => {
    expect(
      robotsAllows('# nothing\nSitemap: https://x.test/s.xml\nUser-agent: *\nDisallow:\n', '/a'),
    ).toBe(true);
    expect(robotsAllows('User-agent: *\nCrawl-delay: 10\nDisallow: /a\n', '/a/b')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /a*\n', '/apple')).toBe(false);
  });
});

describe('politeness', () => {
  it('waits out the interval per host, not across hosts, and logs every request', async () => {
    let clock = 1_000;
    const slept: number[] = [];
    const polite = new Politeness({
      minIntervalMs: 500,
      respectRobots: true,
      now: () => new Date(clock),
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    await polite.before('a.test', 'http://a.test/');
    await polite.before('b.test', 'http://b.test/');
    expect(slept).toEqual([]);
    clock += 100;
    await polite.before('a.test', 'http://a.test/list');
    expect(slept).toEqual([400]);
    expect(polite.requests.map((r) => [r.host, r.url])).toEqual([
      ['a.test', 'http://a.test/'],
      ['b.test', 'http://b.test/'],
      ['a.test', 'http://a.test/list'],
    ]);
    expect(new Date(polite.requests[2]!.at).getTime()).toBe(1_500);
  });

  it('asks robots.txt once per host, and not at all when told not to', async () => {
    const fetched: string[] = [];
    const readRobots = async (url: string) => {
      fetched.push(url);
      return 'User-agent: *\nDisallow: /private/\n';
    };
    const polite = new Politeness({ minIntervalMs: 0, respectRobots: true });
    expect(await polite.allows('a.test', 'http://a.test', '/private/x', readRobots)).toBe(false);
    expect(await polite.allows('a.test', 'http://a.test', '/public', readRobots)).toBe(true);
    expect(fetched).toEqual(['http://a.test/robots.txt']);
    expect(polite.requests).toHaveLength(1);
    const careless = new Politeness({ minIntervalMs: 0, respectRobots: false });
    expect(await careless.allows('a.test', 'http://a.test', '/private/x', readRobots)).toBe(true);
    expect(fetched).toHaveLength(1);
  });
});

describe('the chain contract', () => {
  const evidence = { evidenceId: 'document:0123456789abcdef', hash: 'a'.repeat(64) };
  const document = {
    url: 'https://root.test/sub-processors',
    fetchedAt: '2026-09-04T09:14:00Z',
    evidence,
  };
  const base = {
    root: 'root.test',
    startedAt: '2026-09-04T09:14:00Z',
    finishedAt: '2026-09-04T09:15:00Z',
    limits: DEFAULT_LIMITS,
    requests: [],
  };

  it('has caps of three and twenty-five by default, and refuses a chain that breaks them', () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxDepth: 3,
      maxNodes: 25,
      minIntervalMs: 2_000,
      respectRobots: true,
    });
    const ok = SupplyChainSchema.parse({
      ...base,
      nodes: [
        { id: 'root.test', name: 'Root', host: 'root.test', depth: 0, list: 'read' },
        { id: 'a.test', name: 'A', host: 'a.test', depth: 1, list: 'skipped', skipped: 'no_list' },
      ],
      edges: [
        {
          from: 'root.test',
          to: 'a.test',
          document,
          entry: { name: 'A', host: 'a.test', quote: 'A a.test' },
          cycle: false,
        },
      ],
    });
    expect(ok.dropped).toBe(0);
    const tooDeep = { ...ok, nodes: [ok.nodes[0], { ...ok.nodes[1]!, depth: 4 }] };
    expect(() => SupplyChainSchema.parse(tooDeep)).toThrow(/beyond the depth cap/);
    const tooMany = { ...ok, limits: { ...ok.limits, maxNodes: 1 } };
    expect(() => SupplyChainSchema.parse(tooMany)).toThrow(/more nodes than the cap/);
    const dangling = { ...ok, edges: [{ ...ok.edges[0]!, to: 'nowhere.test' }] };
    expect(() => SupplyChainSchema.parse(dangling)).toThrow(/two nodes on the chain/);
    const silent = { ...ok, nodes: [ok.nodes[0], { ...ok.nodes[1]!, skipped: undefined }] };
    expect(() => SupplyChainSchema.parse(silent)).toThrow(/says why/);
  });
});
