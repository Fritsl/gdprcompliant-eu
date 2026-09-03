import {
  CookieClassificationSchema,
  type CapturedCookie,
  type CookieClassification,
  type CookieEntry,
} from '@gc/contracts';
import type { CookieDatabase } from './database.js';

// A cookie is what the database says it is, or unknown. Several entries that agree are a
// match; entries that disagree make it ambiguous, which is unknown with the candidates
// shown; nothing known is unmatched. No model, no heuristics, no guessing.

export function classifyCookie(
  db: CookieDatabase,
  cookie: { name: string; domain?: string },
): CookieClassification {
  const candidates = db.lookup(cookie.name, cookie.domain);
  const source = {
    name: db.version.source,
    version: db.version.version,
    fetchedAt: db.version.fetchedAt,
  };
  const base = {
    name: cookie.name,
    ...(cookie.domain !== undefined ? { domain: cookie.domain } : {}),
    source,
  };
  if (candidates.length === 0) {
    return CookieClassificationSchema.parse({
      ...base,
      category: 'unknown',
      resolution: 'unmatched',
    });
  }
  const categories = new Set(candidates.map((c) => c.category));
  if (categories.size > 1) {
    return CookieClassificationSchema.parse({
      ...base,
      category: 'unknown',
      resolution: 'ambiguous',
      candidates,
    });
  }
  const match = preferred(candidates);
  return CookieClassificationSchema.parse({
    ...base,
    category: match.category,
    resolution: 'matched',
    match,
    candidates,
  });
}

// Among agreeing entries: an exact name over a prefix, a named domain over none.
function preferred(entries: CookieEntry[]): CookieEntry {
  return [...entries].sort(
    (a, b) =>
      Number(a.wildcard) - Number(b.wildcard) ||
      Number(b.domain !== undefined) - Number(a.domain !== undefined),
  )[0]!;
}

export function classifyCookies(
  db: CookieDatabase,
  cookies: readonly CapturedCookie[],
): CookieClassification[] {
  return cookies.map((c) => classifyCookie(db, { name: c.name, domain: c.domain }));
}
