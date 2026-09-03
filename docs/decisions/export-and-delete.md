# Export and delete: proving the case is theirs

A case is the customer's. Two operations make that true rather than asserted: one
click gives them everything, one click removes everything. Both are ordinary code paths
with tests, not a support ticket.

## Export

`exportCase` produces one JSON file: the case row (without its access token), findings,
the evidence rows each finding rests on with their bodies and hashes, answers, vendors,
processing activities, claims (without code hashes), the ledger entries the case wrote,
the full timeline, and the generated documents. The timeline PDF rides inside the file
as base64. The file's SHA-256 and size are written to the timeline as `export_produced`,
so an export is itself part of the record.

## Delete

`deleteCase` writes `deletion_requested` to the timeline as the last event, then calls
`delete_case`, a definer function that removes every row of the case in dependency
order: finding links, findings, evidence, answers, vendors, processing activities,
claims, ledger entries, events, and the case; and the tenant, when no other case is left
in it. The append-only and immutable triggers on events and evidence let a delete
through only while the session names the case being erased, which the function sets
for its own duration and nothing else can.

What remains is one row in `deletion_audit`: the SHA-256 of the case number, the
country and year from its prefix, when, who asked (`token`, `owner` or `operator`) and
how many rows went. Not the number, not the domain, not a person.

Evidence bodies live in the evidence rows themselves; there is no separate blob store
to leave anything behind in. When one arrives, its objects join the delete order and the
test that asserts nothing survives extends to it.

## Time bounds

Both operations complete inside **30 seconds** on a case of ordinary size
(`EXPORT_TIME_BOUND_MS`, `DELETE_TIME_BOUND_MS`). The integration test measures both
against a populated case rather than trusting the number.

## The page

The case page states what is held, as counts, and who can see it, in the interface
itself, next to the two actions. That copy is part of the deliverable.
