import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { FindingTypeIdSchema, FixtureRouteSchema, NonEmptyStringSchema } from '@gc/contracts';

// Snippet proofs (R-03): every code or config snippet in a self-fix remedy is shown to
// work, against a fixture that starts broken and ends fixed. A proof names the fixture,
// the host and the family to re-run, and the change to apply: headers a server snippet
// adds (read out of the snippet itself), routes, or text replaced in a page the way the
// guide says. A snippet with no proof, or a proof that does not close the finding, fails.

export const SnippetProofSchema = z
  .object({
    remedyId: NonEmptyStringSchema,
    findingTypeId: FindingTypeIdSchema,
    // Where the finding is shown; absent only with an exemption.
    fixture: NonEmptyStringSchema.optional(),
    host: NonEmptyStringSchema.optional(),
    family: z.enum(['security', 'forms', 'replay', 'policies', 'consent', 'recipients']).optional(),
    // The change: headers a server snippet adds are read from the snippet unless given here.
    headers: z.record(z.string().min(1), z.string()).optional(),
    routes: z.array(FixtureRouteSchema).optional(),
    replaceRoutes: z.boolean().optional(),
    replace: z
      .record(z.string().startsWith('/'), z.array(z.tuple([z.string().min(1), z.string()])))
      .optional(),
    // Why no fixture can show this one; the only way a snippet goes unproved.
    exempt: NonEmptyStringSchema.optional(),
  })
  .superRefine((p, ctx) => {
    if (p.exempt) return;
    for (const field of ['fixture', 'host', 'family'] as const) {
      if (!p[field])
        ctx.addIssue({ code: 'custom', message: `${p.remedyId}: a proof names its ${field}` });
    }
    // A proof that lists no change of its own takes its headers from the snippet; the
    // static check (check:guide-snippets) refuses one that ends up changing nothing.
  });
export type SnippetProof = z.infer<typeof SnippetProofSchema>;

export const SnippetProofsSchema = z.object({
  version: z.string().min(1),
  proofs: z.array(SnippetProofSchema),
});
export type SnippetProofs = z.infer<typeof SnippetProofsSchema>;

export const SNIPPET_PROOFS_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../content/snippet-proofs.json',
);

export function loadSnippetProofs(file = SNIPPET_PROOFS_FILE): SnippetProofs {
  return SnippetProofsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

// The headers an nginx snippet adds: every `add_header Name "value" ...;` line.
export function headersFromSnippet(snippet: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of snippet.matchAll(/^\s*add_header\s+([A-Za-z0-9-]+)\s+"([^"]*)"/gm)) {
    out[m[1]!.toLowerCase()] = m[2]!;
  }
  return out;
}
