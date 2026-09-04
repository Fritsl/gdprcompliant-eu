# The performance budget

The front door promises about a minute. `tests/perf/budgets.json` holds the numbers the
scanner is held to, and `tests/perf/scan-budget.test.ts` measures them against the whole
fixture estate:

| Budget | Number | Measured how |
| --- | --- | --- |
| three-pass scan | 60 s at the 95th percentile | every check family on one site, per fixture, the scanner's own dwell |
| deep pass | 10 min in total | every site in sequence, with each site's result handed over as it finishes |
| re-check | under three quarters of a full scan | one family re-run on the same site |

The suite is the `perf` project (`pnpm test:perf`), a nightly gate by design
(`tests/suites.ts`): it runs on a schedule and on demand in `.github/workflows/perf.yml`,
fails the workflow when a number is over budget, and uploads `artifacts/perf-scan.json`
so the trend is visible before a customer notices. It does not run on every push: a
browser-driven pass over the estate is minutes, not seconds, and the per-push gate is the
unit, adversarial and tenancy work in `ci.yml`.

Changing a budget is a content change to `budgets.json`, with the reason in the commit.
