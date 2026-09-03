import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDecisionRef } from '@gc/contracts';
import {
  auditCitations,
  documentChunks,
  findCitations,
  loadCorpusDocuments,
  loadDecisions,
  resolveDecision,
  type CitationProblem,
} from '@gc/corpus';

// The citation audit (T-03): finds every citation shape the content uses, resolves each
// against the corpus as published, confirms quotes by substring, and fails on the
// first thing it cannot prove.

const chunks = loadCorpusDocuments().flatMap(documentChunks);
const decisions = loadDecisions();

function tempContent(files: Record<string, unknown>): { root: string; files: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'audit-'));
  const out: string[] = [];
  for (const [name, json] of Object.entries(files)) {
    const file = join(root, name);
    writeFileSync(file, JSON.stringify(json));
    out.push(file);
  }
  return { root, files: out };
}

describe('finding citations', () => {
  it('finds typed citations and the fixture pair shape, with the nearest jurisdiction', () => {
    const problems: CitationProblem[] = [];
    const found = findCitations(
      {
        jurisdiction: 'DK',
        a: { kind: 'provision', instrument: 'GDPR', article: '6', ref: 'Art. 6' },
        b: [{ instrument: 'ePrivacy', ref: 'Art. 5(3)', note: 'n' }],
        c: { instrument: 'Case law', ref: 'LG München I, 3 O 17493/20' },
        d: { title: 'not a citation', ref: 'x' },
      },
      'f.json',
      problems,
    );
    expect(problems).toEqual([]);
    expect(found.map((f) => [f.path, f.citation.kind, f.jurisdiction])).toEqual([
      ['$.a', 'provision', 'DK'],
      ['$.b[0]', 'provision', 'DK'],
      ['$.c', 'decision', 'DK'],
    ]);
  });

  it('a malformed or unparseable citation is a problem, not a skip', () => {
    const problems: CitationProblem[] = [];
    findCitations(
      [
        { kind: 'provision', instrument: 'GDPR', article: 'six', ref: 'Art. 6' },
        { instrument: 'GDPR', ref: 'somewhere in chapter 3' },
      ],
      'f.json',
      problems,
    );
    expect(problems.map((p) => p.reason)).toEqual(['malformed', 'unparseable']);
  });

  it('parses a decision reference as body and case number', () => {
    expect(parseDecisionRef('CJEU, C-673/17')).toMatchObject({
      body: 'CJEU',
      reference: 'C-673/17',
    });
    expect(parseDecisionRef('no comma')).toBeUndefined();
  });
});

describe('auditing against the corpus', () => {
  it('passes real citations with true quotes, and names every kind of miss', () => {
    const { root, files } = tempContent({
      'ok.json': {
        jurisdiction: 'DE',
        citations: [
          {
            instrument: 'GDPR',
            ref: 'Art. 5(1)(a)',
            quote: 'processed lawfully, fairly and in a transparent manner',
          },
          { instrument: 'GDPR', ref: 'Art. 44–49' },
          {
            instrument: 'ePrivacy',
            ref: 'Art. 5(3)',
            quote:
              'the storing of information, or the gaining of access to information already stored',
          },
          { instrument: 'Case law', ref: 'LG München I, 3 O 17493/20' },
        ],
      },
      'bad.json': {
        jurisdiction: 'DK',
        citations: [
          { instrument: 'GDPR', ref: 'Art. 5(3)' },
          { instrument: 'GDPR', ref: 'Art. 5(1)(a)', quote: 'processed unlawfully' },
          { instrument: 'BDSG', ref: '§ 26' },
          { instrument: 'Case law', ref: 'LG München I, 3 O 17493/20' },
          { instrument: 'Case law', ref: 'CJEU, C-673/17', quote: 'x' },
        ],
      },
    });
    const audit = auditCitations(root, files, chunks, decisions);
    expect(audit.files).toBe(2);
    expect(audit.citations).toBe(8);
    expect(audit.quotes).toBe(4);
    expect(audit.problems.map((p) => [p.file, p.key, p.reason].join(' | ')).sort()).toEqual(
      [
        'bad.json | GDPR:5:3 | no_such_paragraph',
        'bad.json | GDPR:5:1:a | quote_not_found',
        'bad.json | BDSG § 26 | unparseable',
        'bad.json | CJEU:C-673/17 | no_such_paragraph',
      ].sort(),
    );
  });

  it('a quote against a decision without its text is unverifiable, not accepted', () => {
    const { root, files } = tempContent({
      'q.json': {
        jurisdiction: 'DE',
        c: { instrument: 'Case law', ref: 'LG München I, 3 O 17493/20', quote: 'Google Fonts' },
      },
    });
    const audit = auditCitations(root, files, chunks, decisions);
    expect(audit.problems.map((p) => p.reason)).toEqual(['quote_unverifiable']);
    const r = resolveDecision(
      decisions,
      { kind: 'decision', body: 'LG München I', reference: '3 O 17493/20', ref: 'x' },
      'DE',
    );
    expect(r.ok && 'decision' in r && r.decision.decidedAt).toBe('2022-01-20');
  });

  it('a judgment on Union law speaks everywhere; one on a national act only at home', () => {
    const entry = decisions.decisions[0]!;
    const cite = {
      kind: 'decision' as const,
      body: entry.body,
      reference: entry.reference,
      ref: 'x',
    };
    expect(resolveDecision(decisions, cite, 'DK').ok).toBe(true);
    const national = {
      version: decisions.version,
      decisions: [{ ...entry, scope: 'DE' as const }],
    };
    expect(resolveDecision(national, cite, 'DE').ok).toBe(true);
    const abroad = resolveDecision(national, cite, 'DK');
    expect(!abroad.ok && abroad.reason).toBe('wrong_jurisdiction');
  });

  it('a file that is not JSON is a problem', () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-'));
    const file = join(root, 'broken.json');
    writeFileSync(file, '{not json');
    expect(auditCitations(root, [file], chunks, decisions).problems.map((p) => p.reason)).toEqual([
      'unreadable',
    ]);
  });
});
