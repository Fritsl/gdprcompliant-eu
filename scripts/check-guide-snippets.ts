// pnpm run check:guide-snippets (R-03)
//
// Every code or config snippet in a self-fix remedy has a proof: a fixture that shows the
// finding, and the change the snippet describes applied on top, which the guides suite
// runs end to end. This check is the static half, cheap enough for every push: a snippet
// without a proof, a proof naming a fixture or host that does not exist, a fixture that
// does not promise the finding, a server snippet whose headers the proof does not carry,
// or a replacement that does not match the page exactly once, fails the build.

import { DETECTORS } from '@gc/findings';
import { headersFromSnippet, loadCatalogue, loadSnippetProofs } from '@gc/remedies';
import { applyOverrides, loadFixtureSites } from '@gc/scanner';

const problems: string[] = [];
const catalogue = loadCatalogue();
const { proofs } = loadSnippetProofs();
const sites = loadFixtureSites();
const registered = new Set(DETECTORS.map((d) => d.findingTypeId));

const withSnippet = catalogue.entries.filter(
  (e) => e.remedy.kind === 'self_fix' && typeof e.remedy.snippet === 'string' && e.remedy.snippet.length > 0,
);
for (const entry of withSnippet) {
  const mine = proofs.filter((p) => p.remedyId === entry.remedy.id);
  if (!registered.has(entry.remedy.findingTypeId)) continue; // not a launch type; nothing to show
  if (mine.length !== 1) {
    problems.push(`${entry.remedy.id}: ${mine.length === 0 ? 'no proof' : `${mine.length} proofs`} (one is required)`);
    continue;
  }
  const proof = mine[0]!;
  if (proof.findingTypeId !== entry.remedy.findingTypeId)
    problems.push(`${entry.remedy.id}: proof names ${proof.findingTypeId}, remedy is for ${entry.remedy.findingTypeId}`);
  if (proof.exempt) continue;
  const site = sites.find((s) => s.name === proof.fixture);
  if (!site) {
    problems.push(`${entry.remedy.id}: fixture ${proof.fixture} does not exist`);
    continue;
  }
  const host = site.hosts.find((h) => h.host === proof.host);
  if (!host) {
    problems.push(`${entry.remedy.id}: ${proof.fixture} has no host ${proof.host}`);
    continue;
  }
  if (!site.expected.findings.must.includes(proof.findingTypeId))
    problems.push(`${entry.remedy.id}: ${proof.fixture} does not promise ${proof.findingTypeId}, so it does not start broken`);
  const fromSnippet = headersFromSnippet(entry.remedy.kind === 'self_fix' ? (entry.remedy.snippet ?? '') : '');
  const effective = { ...fromSnippet, ...(proof.headers ?? {}) };
  if (Object.keys(effective).length === 0 && !proof.routes && !proof.replace && !proof.replaceRoutes)
    problems.push(`${entry.remedy.id}: the proof changes nothing (no headers in the snippet, no routes, no replacement)`);
  for (const [name, value] of Object.entries(fromSnippet)) {
    if (effective[name] !== value)
      problems.push(`${entry.remedy.id}: the snippet adds ${name}, the proof carries something else`);
  }
  try {
    applyOverrides(host, {
      headers: effective,
      ...(proof.routes ? { routes: proof.routes } : {}),
      ...(proof.replaceRoutes ? { replaceRoutes: true } : {}),
      ...(proof.replace ? { replace: proof.replace } : {}),
    });
  } catch (e) {
    problems.push(`${entry.remedy.id}: ${(e as Error).message}`);
  }
}
for (const p of proofs) {
  if (!catalogue.get(p.remedyId)) problems.push(`proof for ${p.remedyId}: no such remedy`);
}

if (problems.length > 0) {
  console.error(`guide snippets: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
const proved = proofs.filter((p) => !p.exempt).length;
const exempt = proofs.filter((p) => p.exempt).length;
console.log(
  `guide snippets: ${withSnippet.length} snippet(s), ${proved} proved against a fixture, ${exempt} exempt with a reason`,
);
