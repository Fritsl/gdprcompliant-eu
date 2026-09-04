// pnpm check:registries (S-07, D-01)
//
// The curated maps the scanner reads (the vendor registry, the DNS service map, the
// recipient host map) are data with provenance and review dates. This check fails the
// build when a map does not parse, a link points nowhere, or a map entry is claimed
// twice; it warns, and only warns, when an entry is past its review date or was read
// too long ago, and when a map entry has no legal entity behind it yet. A warning needs
// a human owner; it is printed in the form GitHub Actions turns into an annotation.

import {
  auditRegistry,
  auditTransferData,
  staleEntries,
  staleTransferData,
  transferMaps,
} from '@gc/scanner';

const maps = transferMaps();
const audit = auditRegistry(maps);
const stale = staleEntries(maps.registry, new Date());

const warn = (message: string) => {
  const file = 'packages/scanner/data/vendors/registry.json';
  console.log(process.env['GITHUB_ACTIONS'] ? `::warning file=${file}::${message}` : `warning: ${message}`);
};

for (const s of stale) warn(`vendor ${s.id}: ${s.detail}`);
for (const s of staleTransferData(maps, new Date())) warn(`${s.what}: ${s.detail}`);
audit.problems.push(...auditTransferData(maps));
for (const u of audit.unclaimed) warn(`${u.kind} ${u.id} has no legal entity in the vendor registry yet`);

if (audit.problems.length > 0) {
  console.error(`registries: ${audit.problems.length} problem(s)`);
  for (const p of audit.problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(
  `registries: vendors@${maps.registry.version} (${maps.registry.vendors.length}), dns-services@${maps.dns.version} (${maps.dns.services.length}), recipient-hosts@${maps.recipients.version} (${maps.recipients.hosts.length}); ${stale.length} stale, ${audit.unclaimed.length} without a legal entity yet; adequacy@${maps.adequacy.version} (${maps.adequacy.decisions.length}), dpf@${maps.dpf.version} (${maps.dpf.lookups.length} lookups)`,
);
