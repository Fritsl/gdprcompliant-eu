import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// No path in the codebase can rewrite an event (C-02). The database refuses it by
// trigger; this makes sure nobody even tries. The one writer is packages/db/src/timeline.ts.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.next', 'migrations', 'artifacts'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js|sql)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('the timeline is append-only in code as well as in the database', () => {
  const sources = [join(ROOT, 'packages'), join(ROOT, 'apps'), join(ROOT, 'scripts')].flatMap((d) =>
    walk(d),
  );
  const rel = (f: string) => relative(ROOT, f).split(sep).join('/');

  it('nothing updates or deletes case events, and only one module inserts them', () => {
    const rewriters: string[] = [];
    const inserters: string[] = [];
    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      if (/\.(update|delete)\(\s*(schema\.)?caseEvents\b/.test(src)) rewriters.push(rel(file));
      if (/\b(update|delete\s+from)\s+"?case_events"?\b/i.test(src)) rewriters.push(rel(file));
      if (/\.insert\(\s*(schema\.)?caseEvents\b|insert\s+into\s+"?case_events"?\b/i.test(src)) {
        inserters.push(rel(file));
      }
    }
    expect(rewriters).toEqual([]);
    expect(inserters).toEqual(['packages/db/src/timeline.ts']);
    expect(sources.length).toBeGreaterThan(50);
  });
});
