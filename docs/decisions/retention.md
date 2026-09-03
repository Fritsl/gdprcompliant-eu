# Retention: every table has a lifetime, and a job that enforces it

The declarations live in `packages/db/src/retention.ts`, one rule per table by its
database name. `pnpm check:retention` reads the schema snapshot against them and fails
the build for a table without a rule, or a rule without a table. `runRetention` is the
sweep; the `retention-sweep` job runs it nightly at 03:15 and can be enqueued by hand
with a fixed clock.

| Rule | Tables | What happens |
| --- | --- | --- |
| `shared_reference` | app_meta, jurisdictions, remedies | Reference data with no personal data; kept. |
| `with_case` | tenants, case_events, evidence, findings, finding_evidence, vendors, processing_activities, answers, case_members, mail_outbox | Go with the case: the owner's delete, or the unclaimed expiry below, removes them through the same `delete_case`. The tenant goes with its last case. |
| `case` | cases | Claimed: until the owner deletes it. Unclaimed: expires 30 days after opening (the token stops working the moment it does), and is purged 7 days later. |
| `claim` | case_claims | A used code, or an expired unused one, is deleted 30 days later. |
| `months` | demand_entries | 24 months from `seen_at`, then deleted (docs/decisions/demand-ledger.md). |
| `anonymous_forever` | deletion_audit | A hash, a country, a year, a count. Kept so a deletion can be shown to have happened. |

## "Blobs are gone, not only rows"

Evidence bodies are stored in the evidence rows; there is no separate object store yet.
The retention test purges an expired unclaimed case and then searches every table in the
schema for the evidence body and its hash, so the assertion is about the content, not
the row count. When an object store arrives, its objects join `delete_case` and this
test extends to it.

## Adding a table

Declare its rule in `RETENTION` in the same change that adds it, or `check:retention`
fails. If the rule is `with_case`, add the table to `delete_case` in the same migration.
