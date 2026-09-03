# The DNS token-to-service map

`services.json` maps what a domain's public DNS records say to named services: a
verification token prefix in a TXT record, an `include:` in the SPF record, the suffix
of an MX exchange, the suffix of a CNAME target. It is validated by
`DnsServiceMapSchema` in `@gc/contracts`.

The map is curated data, like the vendor registry:

- **Versioned.** `version` is the date the map was last reviewed. Every collection
  records the version it was mapped with, so an old result stays explicable.
- **Provenance on every entry.** `provenance.url` is the vendor's own documentation of
  the record they ask customers to publish; `verifiedAt` is when someone last read it.
  A pattern nobody can point at a source for does not go in.
- **Observable facts only.** An entry says a record pattern belongs to a service and
  where that service's contracting entity sits. It says nothing about what the service
  does with data or whether using it is lawful; that is the case's work, not the map's.

A token, include or exchange the map does not know is reported as `unknown` with its
raw value. The collector never guesses.

## Adding a service

Add an entry with at least one pattern, the jurisdiction of the contracting entity, the
role the service usually takes, and the documentation URL. Bump `version`. The unit
suite checks the file parses, ids are unique, and every entry carries provenance.
