# The vendor registry

`registry.json` names the legal entity behind what the scanner sees: a request host (through
`../recipients/hosts.json`), a DNS record pattern (through `../dns/services.json`), or a host
suffix of its own. It is validated by `VendorRegistrySchema` in `@gc/contracts`.

Every entry carries two entities, because the transfer analysis rests on the difference:

- **`contracting`** is the entity a customer in the EEA contracts with, as the vendor's own
  terms name it. Its `country` is where that entity is established.
- **`parent`** is the ultimate corporate parent and where it sits. A contracting entity in
  Ireland with a parent in the United States is the common case, and it is the case the
  transfer question is about.

The registry is curated data, like the DNS map and the recipient host map:

- **Versioned.** `version` is the date the registry was last reviewed. A vendor row on a case
  records the version it was resolved with.
- **Provenance on every entry.** `provenance.url` is the page of the vendor's own terms the
  entities were read from; `verifiedAt` is when someone read it.
- **A review date on every entry.** `reviewBy` is the day the entry must be read again.
  `pnpm check:registries` warns in CI when that day has passed, or when `verifiedAt` is
  older than 180 days; the warning needs a human owner.
- **Observable facts only.** An entry says who the entity is and where it sits. It says
  nothing about what the vendor does with data or whether using it is lawful.

A host, service or recipient the registry does not cover resolves to `unresolved`, with the
raw value kept; nothing is dropped and nothing is guessed. A DNS service or recipient host
the registry does not claim is reported by the check as a gap, not hidden.

## Adding a vendor

Add an entry with the two entities, the role the vendor usually takes, at least one link
(`hostSuffixes`, `dnsServices` or `recipientHosts`), the terms URL, `verifiedAt` and
`reviewBy`. Bump `version`. The unit suite checks the file parses, ids are unique, every
link points at a real map entry, and no map entry is claimed twice.
