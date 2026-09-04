import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgreementDiscoverySchema, EvidenceSchema, sha256 } from '@gc/contracts';
import {
  BrowserPool,
  FixtureServer,
  agreementDraft,
  discoverAgreement,
  loadFixtureSites,
  scoreAgreementLink,
  type FixtureHost,
} from '@gc/scanner';

// Agreement discovery (D-06) over synthetic supplier sites: one that publishes its
// agreement behind a footer link, one at a well-known path with no link, one whose link
// answers 404, one whose link lands on a login wall, one that links a PDF, one that
// never mentions an agreement, and one that does not exist. Found, unfindable, none and
// unreachable, each with the evidence the outcome rests on.

const identity = {
  tenantId: 't-1',
  caseId: 'DK-26-0M4K',
  scanId: 'scan-1',
  capturedAt: '2026-09-04T09:14:00Z',
};
const root = mkdtempSync(join(tmpdir(), 'agreements-'));

const page = (title: string, body: string, lang = 'en') =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const agreementBody = (lang: 'en' | 'da' | 'de') => {
  const sentence = {
    en: 'The Processor processes personal data only on documented instructions from the Controller and notifies the Controller of a personal data breach within 24 hours. ',
    da: 'Databehandleren behandler kun personoplysninger efter dokumenteret instruks fra den dataansvarlige og underretter den dataansvarlige om brud inden 24 timer. ',
    de: 'Der Auftragsverarbeiter verarbeitet personenbezogene Daten nur auf dokumentierte Weisung des Verantwortlichen und meldet Verletzungen innerhalb von 24 Stunden. ',
  }[lang];
  return `<h1>Data Processing Agreement</h1><p>${sentence.repeat(14)}</p>`;
};

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
  host('ag1.test', {
    'index.html': page(
      'Sendmore',
      `<main>Email for everyone.</main><footer><a href="/privacy">Privacy</a> <a href="/legal/dpa">Data Processing Agreement</a></footer>`,
    ),
    'legal/dpa/index.html': page('DPA', agreementBody('en')),
    'privacy/index.html': page('Privacy', '<p>privacy</p>'),
  }),
  host('ag2.test', {
    'index.html': page('Cloudhus', `<footer><a href="/dpa">Databehandleraftale</a></footer>`, 'da'),
  }),
  host('ag3.test', {
    'index.html': page('Helpdesk', `<footer><a href="/avv">AVV</a></footer>`, 'de'),
    'avv/index.html': page('Anmelden', '<h1>Bitte anmelden</h1><p>Passwort:</p>', 'de'),
  }),
  host('ag4.test', {
    'index.html': page(
      'KontaktWerk',
      `<main>CRM.</main><footer><a href="/impressum">Impressum</a></footer>`,
      'de',
    ),
    'auftragsverarbeitung/index.html': page('Auftragsverarbeitung', agreementBody('de'), 'de'),
    'impressum/index.html': page('Impressum', '<p>KontaktWerk GmbH</p>', 'de'),
  }),
  host('ag5.test', {
    'index.html': page(
      'Pixelværk',
      `<main>Vi bygger hjemmesider.</main><footer><a href="/om">Om os</a></footer>`,
      'da',
    ),
    'om/index.html': page('Om os', '<p>Et bureau i Vejle.</p>', 'da'),
  }),
  host('ag6.test', {
    'index.html': page('Metrix', `<footer><a href="/legal/dpa.pdf">DPA</a></footer>`),
  }),
];

const sites = loadFixtureSites();
let server: FixtureServer;
let pool: BrowserPool;

beforeAll(async () => {
  server = await new FixtureServer([...sites.flatMap((s) => s.hosts), ...hosts]).start();
  pool = await new BrowserPool({
    concurrency: 3,
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

const discover = (n: number, vendorName?: string) =>
  discoverAgreement(
    pool,
    { url: `http://ag${n}.test/` },
    {
      identity,
      ...(vendorName ? { vendorName } : {}),
      now: () => new Date('2026-09-04T09:14:00Z'),
    },
  );

describe('agreement discovery (D-06)', () => {
  it('scores a link on its words and its path, in three languages', () => {
    const link = (text: string, href: string, inFooter = true) => ({ href, text, inFooter });
    expect(scoreAgreementLink(link('Data Processing Agreement', 'http://x.test/legal/dpa'))).toBe(
      17,
    );
    expect(scoreAgreementLink(link('Databehandleraftale', 'http://x.test/aftale'))).toBe(12);
    expect(scoreAgreementLink(link('AVV', 'http://x.test/avv', false))).toBe(15);
    expect(scoreAgreementLink(link('Privacy', 'http://x.test/privacy'))).toBe(0);
    expect(scoreAgreementLink(link('Terms', 'http://x.test/terms'))).toBe(0);
  });

  it('finds the agreement behind a link, stores it as a document, and raises nothing', async () => {
    const r = await discover(1, 'Sendmore');
    expect(r.discovery.outcome).toBe('found');
    expect(r.discovery.document?.foundBy).toBe('link');
    expect(r.discovery.document?.finalUrl).toBe('http://ag1.test/legal/dpa');
    expect(r.discovery.document?.words).toBeGreaterThanOrEqual(200);
    expect(r.discovery.summary).toContain('Sendmore publishes a processing agreement');
    const doc = r.evidence.find((e) => e.id === r.discovery.document?.evidence.evidenceId)!;
    expect(EvidenceSchema.parse(doc).kind).toBe('document');
    expect(doc.hash).toBe(sha256(doc.body));
    expect(doc.caption).toContain('processing agreement of Sendmore');
    expect(doc.body).toContain('documented instructions');
    expect(agreementDraft(r, 'eksempelbutik.dk')).toBeUndefined();
  });

  it('finds it at a well-known path when nothing links to it', async () => {
    const r = await discover(4);
    expect(r.discovery.outcome).toBe('found');
    expect(r.discovery.document?.foundBy).toBe('well-known');
    expect(r.discovery.document?.finalUrl).toBe('http://ag4.test/auftragsverarbeitung');
    expect(r.discovery.document?.language).toBe('de');
  });

  it('a link that answers 404 is unfindable, with the trail as evidence', async () => {
    const r = await discover(2, 'Cloudhus');
    expect(r.discovery.outcome).toBe('unfindable');
    expect(r.discovery.trail).toEqual([
      { url: 'http://ag2.test/dpa', reason: 'answered an error or nothing' },
    ]);
    expect(r.evidence.map((e) => e.kind).sort()).toEqual(['document', 'text']);
    const trail = r.evidence.find((e) => e.kind === 'text')!;
    expect(trail.body).toContain('http://ag2.test/dpa: answered an error or nothing');
    const draft = agreementDraft(r, 'eksempelbutik.dk')!;
    expect(draft.typeId).toBe('DPA-02');
    expect(draft.subject).toEqual({ host: 'eksempelbutik.dk' });
    expect(draft.hosts).toEqual(['ag2.test']);
    expect(draft.evidence).toEqual(r.discovery.evidence);
    expect(draft.summary).toContain('Cloudhus mentions a processing agreement');
  });

  it('a login wall and a PDF are unfindable too, and say so', async () => {
    const wall = await discover(3);
    expect(wall.discovery.outcome).toBe('unfindable');
    expect(wall.discovery.trail[0]?.reason).toMatch(/behind a login/);
    const pdf = await discover(6);
    expect(pdf.discovery.outcome).toBe('unfindable');
    expect(pdf.discovery.trail[0]?.reason).toMatch(/a PDF/);
    expect(pdf.discovery.trail).toHaveLength(1);
  });

  it('a site that never mentions one is none, evidenced by the pages searched', async () => {
    const r = await discover(5, 'Pixelværk');
    expect(r.discovery.outcome).toBe('none');
    expect(r.discovery.trail).toEqual([]);
    expect(r.discovery.fetched).toBeGreaterThanOrEqual(1);
    const home = r.evidence.find((e) => e.kind === 'document')!;
    expect(home.caption).toContain('searched for a processing agreement');
    const draft = agreementDraft(r, 'eksempelbutik.dk')!;
    expect(draft.typeId).toBe('DPA-01');
    expect(draft.summary).toContain('Pixelværk processes personal data for eksempelbutik.dk');
  });

  it('a site that does not answer is unreachable, which raises nothing', async () => {
    const r = await discover(7);
    expect(r.discovery.outcome).toBe('unreachable');
    expect(r.evidence).toEqual([]);
    expect(agreementDraft(r, 'eksempelbutik.dk')).toBeUndefined();
    expect(() => AgreementDiscoverySchema.parse(r.discovery)).not.toThrow();
  });
});
