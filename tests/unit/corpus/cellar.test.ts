import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CASSETTES_DIR, createRecordedFetch, loadConfig } from '@gc/config';
import {
  CONTENT_DIR,
  blockLines,
  documentFromCellar,
  fetchCellar,
  parseArticle,
  parseArticles,
  type CorpusSource,
} from '@gc/corpus';

// Union instruments from the cellar (T-03): the recorded Official Journal text, cut the
// same way every time, is exactly the committed content file, so the corpus cannot
// drift from its source; and the cut is right where it matters.

const config = loadConfig({
  DATABASE_URL: 'postgres://gc:gc@localhost:5432/gdprcompliant',
  MODEL_BASE_URL: 'http://localhost:8000/v1',
  MODEL_CHAT: 'chat-model',
  MODEL_EMBEDDING: 'embedding-model',
  APP_BASE_URL: 'https://gdprcompliant.eu',
  GC_NETWORK: 'replay',
});
const outbound = createRecordedFetch(config, { name: 'corpus-cellar' });
const sources = JSON.parse(
  readFileSync(join(CONTENT_DIR, 'sources.json'), 'utf8'),
) as CorpusSource[];

describe('the committed content is the recorded text, cut', () => {
  it.each(sources.map((s) => [s.instrument, s] as const))('%s', async (_, source) => {
    const committed = JSON.parse(
      readFileSync(join(CONTENT_DIR, `${source.instrument}.json`), 'utf8'),
    );
    const html = await fetchCellar(outbound, source.celex);
    const cut = documentFromCellar(source, html, {
      version: committed.version,
      retrievedAt: committed.source.retrievedAt,
    });
    expect(cut).toEqual(committed);
  });

  it('every cellar cassette is over https on the one host, and the redirect was not followed blind', () => {
    const dir = join(CASSETTES_DIR, 'corpus-cellar');
    const files = readdirSync(dir);
    expect(files.length).toBe(sources.length * 2);
    for (const f of files) {
      const cassette = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      expect(cassette.request.url).toMatch(/^https:\/\/publications\.europa\.eu\//);
      expect([200, 303]).toContain(cassette.response.status);
    }
  });
});

describe('the cut', () => {
  const gdpr = JSON.parse(readFileSync(join(CONTENT_DIR, 'GDPR.json'), 'utf8')) as {
    chunks: {
      article: string;
      paragraph?: string;
      point?: string;
      heading?: string;
      text: string;
    }[];
  };
  const find = (article: string, paragraph?: string, point?: string) =>
    gdpr.chunks.find(
      (c) => c.article === article && c.paragraph === paragraph && c.point === point,
    );

  it('an article with paragraphs and points yields the article, each paragraph and each point', () => {
    expect(find('5')?.heading).toBe('Principles relating to processing of personal data');
    expect(find('5', '1')?.text.startsWith('Personal data shall be:')).toBe(true);
    expect(find('5', '1', 'a')?.text).toMatch(
      /^processed lawfully, fairly and in a transparent manner/,
    );
    expect(find('5', '2')?.text).toMatch(/accountability/);
    expect(find('5', '3')).toBeUndefined();
  });

  it('a single-paragraph article is one chunk keyed by the article alone', () => {
    expect(find('44')?.text).toMatch(/^Any transfer of personal data/);
    expect(find('44', '1')).toBeUndefined();
    expect(find('44')?.text).not.toMatch(/^[>\s]/);
  });

  it('bracket-numbered items read as paragraphs, the way they are cited', () => {
    expect(find('4', '11')?.text).toMatch(/^‘consent’ of the data subject means/);
    expect(find('4', '1')?.text).toMatch(/^‘personal data’ means/);
  });

  it('every chunk carries its heading and no chunk starts with markup residue', () => {
    for (const c of gdpr.chunks) {
      expect(c.heading, `${c.article}`).toBeTruthy();
      expect(c.text).not.toMatch(/^[>\s]|<|&[a-z#0-9]+;/);
    }
  });

  it('decodes entities, drops amendment marks, and keeps the consolidated paragraph markers', () => {
    expect(blockLines('<p>a &amp; b&#160;c ►M2 d ◄</p><p class="modref">▼M2</p>')).toEqual([
      'a & b c d',
    ]);
    const chunks = parseArticle('9', 'Title', [
      '1.',
      'First paragraph.',
      '(a)',
      'point a;',
      '(b) point b.',
      '2. Second.',
    ]);
    expect(chunks.map((c) => [c.paragraph, c.point, c.text])).toEqual([
      [undefined, undefined, '1. First paragraph.\n(a) point a;\n(b) point b.\n2. Second.'],
      ['1', undefined, 'First paragraph.\n(a) point a;\n(b) point b.'],
      ['1', 'a', 'point a;'],
      ['1', 'b', 'point b.'],
      ['2', undefined, 'Second.'],
    ]);
    expect(parseArticles('<html><body>no articles</body></html>')).toEqual([]);
  });
});
