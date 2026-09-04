import { describe, expect, it } from 'vitest';
import { DETECTORS } from '@gc/findings';
import { headersFromSnippet, loadCatalogue, loadSnippetProofs } from '@gc/remedies';
import { applyOverrides, loadFixtureSites } from '@gc/scanner';

// Snippet proofs (R-03), the static half: the file parses, every proof names a real
// remedy and a fixture that promises its finding, server snippets' headers are read out
// of the snippet, and every replacement matches its page exactly once.

const catalogue = loadCatalogue();
const { proofs } = loadSnippetProofs();
const sites = loadFixtureSites();
const registered = new Set(DETECTORS.map((d) => d.findingTypeId));

describe('the headers a server snippet adds', () => {
  it('are read from add_header lines, lower-cased, whatever follows the value', () => {
    expect(
      headersFromSnippet(
        '# nginx\nadd_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;\n  add_header X-Content-Type-Options "nosniff";\nreturn 301 https://x/;',
      ),
    ).toEqual({
      'strict-transport-security': 'max-age=63072000; includeSubDomains',
      'x-content-type-options': 'nosniff',
    });
    expect(headersFromSnippet('<button>Reject all</button>')).toEqual({});
  });
});

describe('the proofs', () => {
  it('cover every self-fix snippet of a registered type, once, or say why not', () => {
    const snippets = catalogue.entries.filter(
      (e) =>
        e.remedy.kind === 'self_fix' &&
        typeof e.remedy.snippet === 'string' &&
        e.remedy.snippet.length > 0 &&
        registered.has(e.remedy.findingTypeId),
    );
    expect(snippets.length).toBeGreaterThan(15);
    for (const e of snippets) {
      const mine = proofs.filter((p) => p.remedyId === e.remedy.id);
      expect(mine, e.remedy.id).toHaveLength(1);
      expect(mine[0]!.findingTypeId).toBe(e.remedy.findingTypeId);
    }
  });

  it('name real fixtures that start broken, and replacements that match exactly once', () => {
    for (const p of proofs) {
      expect(catalogue.get(p.remedyId), p.remedyId).toBeDefined();
      if (p.exempt) continue;
      const site = sites.find((s) => s.name === p.fixture)!;
      expect(site, `${p.remedyId}: fixture ${p.fixture}`).toBeDefined();
      expect(
        site.expected.findings.must,
        `${p.remedyId}: ${p.fixture} promises ${p.findingTypeId}`,
      ).toContain(p.findingTypeId);
      const host = site.hosts.find((h) => h.host === p.host)!;
      expect(host, `${p.remedyId}: host ${p.host}`).toBeDefined();
      const fixed = applyOverrides(host, {
        ...(p.headers ? { headers: p.headers } : {}),
        ...(p.routes ? { routes: p.routes } : {}),
        ...(p.replaceRoutes ? { replaceRoutes: true } : {}),
        ...(p.replace ? { replace: p.replace } : {}),
      });
      expect(fixed.host).toBe(host.host);
      // The original on disk is untouched: a replaced page is served as a route.
      for (const path of Object.keys(p.replace ?? {}))
        expect(fixed.routes.some((r) => r.path === path)).toBe(true);
    }
  });

  it('a replacement that does not match, or matches twice, is refused', () => {
    const site = sites.find((s) => s.name === 'insecure-forms')!;
    const host = site.hosts[0]!;
    expect(() =>
      applyOverrides(host, { replace: { '/index.html': [['no such text anywhere', 'x']] } }),
    ).toThrow(/occurs 0 times/);
    expect(() => applyOverrides(host, { replace: { '/index.html': [['<label>', 'x']] } })).toThrow(
      /times, not once/,
    );
    expect(() => applyOverrides(host, { replace: { '/nope.html': [['a', 'b']] } })).toThrow(
      /not a file/,
    );
  });
});
