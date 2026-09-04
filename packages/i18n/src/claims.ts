import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LocalisedTextSchema, NonEmptyStringSchema, type LocalisedText } from '@gc/contracts';

// Claim discipline (O-03). The product never certifies, approves or guarantees anything,
// never states compliance as a verdict about a customer, and never calls a named vendor
// unlawful: it describes what was observed and cites a decision. The vocabulary that
// enforces this is content (content/claims.json), per locale, with the few allowed uses
// named file by file. The audit reads every localised string in the content set.

export const ClaimVocabularySchema = z.object({
  version: NonEmptyStringSchema,
  banned: z.array(
    z.object({
      locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
      pattern: NonEmptyStringSchema,
      why: NonEmptyStringSchema,
    }),
  ),
  allow: z.array(
    z.object({
      // Repo-relative, forward slashes.
      file: NonEmptyStringSchema,
      // The dotted path of the localised text; '' allows the whole file.
      path: z.string(),
      why: NonEmptyStringSchema,
    }),
  ),
});
export type ClaimVocabulary = z.infer<typeof ClaimVocabularySchema>;

export const CLAIMS_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'content',
  'claims.json',
);

export function loadClaimVocabulary(file: string = CLAIMS_FILE): ClaimVocabulary {
  const parsed = ClaimVocabularySchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`claims vocabulary: ${parsed.error.message}`);
  for (const b of parsed.data.banned) new RegExp(b.pattern, 'iu'); // a bad pattern fails here
  return parsed.data;
}

export interface ClaimHit {
  readonly locale: string;
  readonly pattern: string;
  readonly match: string;
  readonly why: string;
}

// Every banned claim in one string of one locale.
export function bannedClaims(text: string, locale: string, vocab: ClaimVocabulary): ClaimHit[] {
  const hits: ClaimHit[] = [];
  for (const b of vocab.banned) {
    if (b.locale !== locale) continue;
    const m = new RegExp(b.pattern, 'iu').exec(text);
    if (m) hits.push({ locale, pattern: b.pattern, match: m[0], why: b.why });
  }
  return hits;
}

export interface ClaimProblem extends ClaimHit {
  readonly file: string;
  readonly path: string;
}

const isLocalisedText = (v: unknown): v is LocalisedText =>
  LocalisedTextSchema.safeParse(v).success;

function localisedStrings(
  value: unknown,
  path = '',
  out: { path: string; text: LocalisedText }[] = [],
) {
  if (isLocalisedText(value)) out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => localisedStrings(v, `${path}[${i}]`, out));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      localisedStrings(v, path === '' ? k : `${path}.${k}`, out);
    }
  }
  return out;
}

// The customer-facing content set: every JSON under packages/*/content and apps/*/content,
// except the corpus, which is the law as published and quotes whatever the law says.
export function contentFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.json')) out.push(full);
    }
  };
  for (const scope of ['packages', 'apps']) {
    const base = join(root, scope);
    let names: string[] = [];
    try {
      names = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      if (scope === 'packages' && name === 'corpus') continue;
      const content = join(base, name, 'content');
      try {
        if (statSync(content).isDirectory()) walk(content);
      } catch {
        /* no content here */
      }
    }
  }
  return out.sort();
}

export interface ClaimAudit {
  readonly files: number;
  readonly strings: number;
  readonly problems: ClaimProblem[];
  // Allowed uses that no string needed: a stale allowance is a gap in the guard.
  readonly unusedAllowances: ClaimVocabulary['allow'];
}

export function auditClaims(
  root: string,
  files: readonly string[],
  vocab: ClaimVocabulary = loadClaimVocabulary(),
): ClaimAudit {
  const problems: ClaimProblem[] = [];
  const used = new Set<number>();
  let strings = 0;
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    const json: unknown = JSON.parse(readFileSync(file, 'utf8'));
    for (const { path, text } of localisedStrings(json)) {
      strings += 1;
      for (const [locale, value] of Object.entries(text)) {
        const hits = bannedClaims(value, locale, vocab);
        if (hits.length === 0) continue;
        const allowed = vocab.allow.findIndex(
          (a) => a.file === rel && (a.path === '' || a.path === path),
        );
        if (allowed >= 0) {
          used.add(allowed);
          continue;
        }
        for (const h of hits) problems.push({ file: rel, path, ...h });
      }
    }
  }
  return {
    files: files.length,
    strings,
    problems,
    unusedAllowances: vocab.allow.filter((_, i) => !used.has(i)),
  };
}
