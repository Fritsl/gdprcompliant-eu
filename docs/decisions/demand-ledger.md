# The demand ledger: what it holds, why, and for how long

Every time the catalogue has no remedy for a finding, the customer still gets an answer
(`any-00-no-solution`, R-02) and the gap is written down. The ledger is the product's
list of what to build or partner for next, ranked by how many customers hit the same
wall. This page is the purpose and retention statement for that data, written before
the first row landed.

## Purpose

One purpose: deciding which gaps in the remedy catalogue to close first. The ledger is
read as a ranked, aggregated view — which finding types, in which jurisdictions and
sectors, most often ended in "no solution". It is not used to contact anyone, to score a
customer, or to describe any single company.

## What a row holds

| Column | Why it is there |
| --- | --- |
| `finding_type_id`, `jurisdiction`, `gap`, `cause` | The thing nobody could fix, and why the resolver gave up. |
| `country`, `sector`, `sector_code`, `headcount_band` | So the ranking can say "Danish retailers under 50 people", not just "someone". Company-level bands, never a name. |
| `answer` | `none`, `partial` or `ours`: whether anything was offered at all. |
| `tenant_id`, `case_id` | To count distinct customers and cases, and to purge a tenant's rows when they leave. Never in the read view. |
| `seen_at` | When it happened. |

No personal data is written: no names, no addresses, no domains, no contact details.
The company fields are the same bands the case already carries.

## Read-time anonymisation

The ranked view is produced by `demand_ranked(k)`, a database function that aggregates
across tenants and returns only groups with at least `k` distinct tenants (default 3).
Groups that would identify a single company by being too specific — one sector, one
headcount band, one country — are dropped, and the same threshold applies to the
per-finding-type totals. The function returns counts and dates, never identifiers. It is
the only cross-tenant read path; the table itself is under row-level security like every
other, so a tenant sees only its own rows.

## Retention

Rows are kept for **24 months** from `seen_at`, then deleted (`purgeDemandEntries`). A
tenant's rows are deleted with the tenant. Two years is long enough for a gap to show up
as a trend and short enough that the ranking reflects the catalogue as it is now, not as
it was.

## Export

The ranked view is available as a page and as CSV, both produced from the same function
with the same threshold. Neither contains a tenant id, a case id, or anything a reader
could join back to one company.
