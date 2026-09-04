import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { behaviourValues, fillBehaviour, loadBehaviour, scannerUserAgent } from '@gc/config';
import {
  CRAWLER_AGENT,
  Etiquette,
  SCANNER_USER_AGENT,
  consentGate,
  domainOf,
  identityHeaders,
  privateAddress,
  robotsAllows,
  robotsDisallows,
  scoreAgreementLink,
  scoreLink,
  scoreListLink,
} from '@gc/scanner';

// Crawl etiquette without a browser (D-11): the code is held to the published
// behaviour, name by name and number by number; the limiter keeps one request per host
// per interval and the per-minute counts with an injected clock; robots.txt is read
// one way for every reader; a consent gate is never a link worth following; and each
// thing the page says the scanner never does has a guard in the code.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const spec = loadBehaviour();

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourcesUnder(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}
const scannerSource = sourcesUnder(join(ROOT, 'packages', 'scanner', 'src')).map((f) => ({
  file: f,
  text: readFileSync(f, 'utf8'),
}));

describe('the code matches the page', () => {
  it('announces the name, version and page the behaviour declares, and the header', () => {
    expect(SCANNER_USER_AGENT).toBe(scannerUserAgent());
    expect(SCANNER_USER_AGENT).toBe(
      `${spec.agent.name}/${spec.agent.version} (+${spec.agent.url})`,
    );
    expect(spec.agent.url).toMatch(/\/en\/scanner$/);
    expect(identityHeaders()).toEqual({
      [spec.identity.header]: spec.agent.url,
      From: spec.agent.contact,
    });
    expect(CRAWLER_AGENT).toBe(spec.identity.robotsGroup);
    expect(new Etiquette().userAgent()).toBe(SCANNER_USER_AGENT);
  });

  it('keeps the limits the page states, by default', () => {
    expect(new Etiquette().limits).toEqual(spec.limits);
    expect(spec.limits.minIntervalMs).toBeGreaterThanOrEqual(500);
    expect(spec.limits.perHostPerMinute).toBeLessThanOrEqual(60);
    expect(spec.limits.perDomainPerMinute).toBeGreaterThanOrEqual(spec.limits.perHostPerMinute);
    expect(spec.limits.passesPerScan).toBe(3);
  });

  it('fills every placeholder on the page from the same values the code reads', () => {
    const values = behaviourValues();
    for (const s of spec.page.sections) {
      for (const locale of ['en', 'da', 'de'] as const) {
        const filled = fillBehaviour(s.body[locale]!, values);
        expect(filled, `${s.id} ${locale}`).not.toMatch(/\{\{/);
      }
    }
    const identity = spec.page.sections.find((s) => s.id === 'identity')!;
    expect(fillBehaviour(identity.body['en']!, values)).toContain(SCANNER_USER_AGENT);
    expect(fillBehaviour(identity.body['en']!, values)).toContain(spec.identity.header);
    const pace = spec.page.sections.find((s) => s.id === 'pace')!;
    expect(fillBehaviour(pace.body['en']!, values)).toContain(`${spec.limits.minIntervalMs} ms`);
    expect(fillBehaviour(pace.body['en']!, values)).toContain(
      `${spec.limits.perHostPerMinute} a minute`,
    );
  });

  it('has a guard in the code for each thing the page says it never does', async () => {
    expect(spec.never).toEqual([
      'authenticate',
      'submit',
      'consent_gate',
      'download',
      'private_address',
    ]);
    // authenticate: nothing in the scanner fills a field or types into one.
    const typing = scannerSource.filter(
      (s) => /\.(fill|type|setInputFiles)\(/.test(s.text) || /\bpage\.keyboard\b/.test(s.text),
    );
    expect(typing.map((s) => s.file)).toEqual([]);
    // submit: a navigation that is a form submission is refused before it leaves.
    const etiquette = new Etiquette({ limits: { minIntervalMs: 0 }, robots: false });
    expect(
      await etiquette.judge({
        url: 'https://x.test/login',
        method: 'POST',
        resourceType: 'Document',
      }),
    ).toBe('a form submission');
    expect(
      await etiquette.judge({
        url: 'https://user:pw@x.test/',
        method: 'GET',
        resourceType: 'Document',
      }),
    ).toBe('credentials in the address');
    // consent_gate: a link that asks for agreement first scores nothing anywhere.
    const gate = {
      href: 'https://x.test/privacy?accept=1',
      text: 'I agree and continue',
      inFooter: true,
    };
    expect(scoreLink(gate)).toEqual([]);
    expect(scoreAgreementLink({ ...gate, text: 'Accept the terms to read the DPA' })).toBe(0);
    expect(scoreListLink({ ...gate, text: 'Sub-processors (by continuing you accept)' })).toBe(0);
    // download: the pool opens every context with downloads refused.
    const pool = scannerSource.find((s) => s.file.endsWith('pool.ts'))!;
    expect(pool.text).toContain('acceptDownloads: false');
    // private_address: the egress guard refuses private ranges however a name resolves.
    expect(privateAddress('10.1.2.3')).toBe(true);
    expect(privateAddress('169.254.169.254')).toBe(true);
    expect(privateAddress('93.184.216.34')).toBe(false);
  });
});

describe('the limiter', () => {
  const fake = () => {
    let clock = 10_000;
    const slept: number[] = [];
    const etiquette = new Etiquette({
      limits: { minIntervalMs: 500, perHostPerMinute: 3, perDomainPerMinute: 4 },
      robots: false,
      now: () => new Date(clock),
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    return { etiquette, slept, tick: (ms: number) => (clock += ms), clockNow: () => clock };
  };
  const nav = (url: string) => ({ url, method: 'GET', resourceType: 'Document' });

  it('holds a second navigation to one host until the interval has passed', async () => {
    const { etiquette, slept } = fake();
    expect(await etiquette.judge(nav('https://a.test/'))).toBeUndefined();
    expect(await etiquette.judge(nav('https://b.test/'))).toBeUndefined();
    expect(slept).toEqual([]);
    expect(await etiquette.judge(nav('https://a.test/privacy'))).toBeUndefined();
    expect(slept).toEqual([500]);
    expect(etiquette.navigations.map((n) => n.host)).toEqual(['a.test', 'b.test', 'a.test']);
  });

  it('never holds a sub-resource, and counts navigations per host and per domain per minute', async () => {
    const { etiquette, slept, tick } = fake();
    expect(
      await etiquette.judge({ url: 'https://a.test/x.js', method: 'GET', resourceType: 'Script' }),
    ).toBeUndefined();
    expect(etiquette.navigations).toEqual([]);
    for (const path of ['/1', '/2', '/3']) {
      await etiquette.judge(nav(`https://a.test${path}`));
      tick(500);
    }
    // The fourth in the same minute waits for the first to fall out of the window.
    await etiquette.judge(nav('https://a.test/4'));
    expect(slept.at(-1)).toBeGreaterThan(50_000);
    // The domain window counts both hosts of one domain.
    const { etiquette: e2, slept: s2, tick: t2 } = fake();
    for (const host of ['a.shop.test', 'b.shop.test', 'c.shop.test', 'd.shop.test']) {
      await e2.judge(nav(`https://${host}/`));
      t2(10);
    }
    expect(s2).toEqual([]);
    await e2.judge(nav('https://e.shop.test/'));
    expect(s2).toHaveLength(1);
    expect(s2[0]).toBeGreaterThan(59_000);
  });

  it('reads robots.txt once per host and refuses a disallowed path, but never the page asked for', async () => {
    const fetched: string[] = [];
    const readRobots = async (url: string) => {
      fetched.push(url);
      return 'User-agent: *\nDisallow: /legal/\n';
    };
    const etiquette = new Etiquette({ limits: { minIntervalMs: 0 } });
    const targetUrl = 'https://a.test/legal/home';
    expect(await etiquette.judge({ ...nav(targetUrl), targetUrl, readRobots })).toBeUndefined();
    expect(
      await etiquette.judge({ ...nav('https://a.test/legal/privacy'), targetUrl, readRobots }),
    ).toBe('robots.txt disallows it');
    expect(
      await etiquette.judge({ ...nav('https://a.test/privacy'), targetUrl, readRobots }),
    ).toBeUndefined();
    expect(
      await etiquette.judge({ ...nav('https://a.test/robots.txt'), targetUrl, readRobots }),
    ).toBeUndefined();
    expect(fetched).toEqual(['https://a.test/robots.txt']);
  });
});

describe('robots.txt and domains', () => {
  it('is read one way for every reader', () => {
    const robots = 'User-agent: gdprcompliant\nDisallow: /private/\n\nUser-agent: *\nDisallow: /\n';
    expect(robotsAllows(robots, '/private/x')).toBe(false);
    expect(robotsAllows(robots, '/public')).toBe(true);
    expect(robotsDisallows(robots, '/private/x')).toBe(true);
    expect(robotsDisallows(robots, '/public')).toBe(false);
    expect(robotsAllows(robots, '/public', 'someone-else')).toBe(false);
  });

  it('knows a consent gate in three languages, and a registrable domain near enough', () => {
    expect(consentGate('I agree to the terms')).toBe(true);
    expect(consentGate('Jeg accepterer vilkårene')).toBe(true);
    expect(consentGate('Ich stimme zu')).toBe(true);
    expect(consentGate('Privacy policy')).toBe(false);
    expect(domainOf('www.shop.example.co.uk')).toBe('example.co.uk');
    expect(domainOf('a.b.eksempelbutik.dk')).toBe('eksempelbutik.dk');
    expect(domainOf('localhost')).toBe('localhost');
  });
});
