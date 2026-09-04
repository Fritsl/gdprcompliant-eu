# The canary

Fixtures prove the scanner does what we designed. The canary proves it still works on
the actual internet (T-10).

## What runs

Every night `.github/workflows/canary.yml` scans every active site in
`fixtures/canary/corpus.json`: the home page only, the three passes, one site at a
time, five seconds apart, skipping any site whose `robots.txt` disallows everyone. Each
site gets one snapshot under `artifacts/canary/<date>/<host>.json` with two parts:

- **raw**: what was observed. Third-party hosts contacted, cookie names set on the
  first load, the names of the site's own response headers, whether a policy was
  found, how many forms. Nothing here depends on a detector.
- **derived**: what the scanner made of it. The findings, as type, severity and
  subject, the same shape as a fixture golden.

The snapshot also records the scanner build (the commit) and the families that ran.

## The diff

`pnpm canary:check` compares the two most recent nights, site by site:

| raw       | derived   | verdict           | alarm |
| --------- | --------- | ----------------- | ----- |
| same      | same      | none              |       |
| changed   | same      | site changed      |       |
| same      | changed   | **scanner changed** | yes   |
| changed   | changed   | site changed      |       |
| changed   | changed   | both, across a build change | yes |

Two fleet-wide rules sit on top. When a fifth or more of the scanned sites change
their findings on one night, the internet did not move that much; the scanner did, and
the report says so. When more sites are unreachable than scanned, the runner is the
problem, not the sites.

The check exits non-zero on an alarm, the workflow opens an issue labelled `canary`
with the report as its body, and the owner gets it.

## The owner

Named in the corpus: **Frits Lyneborg**, `fly@frits.ai`. The owner reads the report,
triages within one working day, and decides whether a change is the internet or the
scanner. Nobody else closes a canary issue.

## Triage

1. Read the report in the issue. Every non-quiet site is listed with what changed, in
   words: which hosts appeared, which cookies vanished, which finding is new.
2. **Scanner changed** on one site: check out the commit the snapshot names
   (`scanner.commit` in both nights' files) and diff the two builds' detectors for the
   finding type named. If the detector changed on purpose, the fixture goldens should
   have changed with it (`pnpm goldens:update` and the reviewed diff); if they did not,
   the canary found a change the fixtures do not cover. Add a fixture.
3. **Fleet shift**: the same finding appears or disappears across many sites at once.
   That is a detector, a vendor map or a curated list (`packages/scanner/data`). Find
   the commit between the two nights that touched it, and decide whether the new
   answer is right on the sites listed.
4. **Site changed**, quietly: nothing to do. That is what the corpus is for.
5. **Unreachable** beyond a handful: the runner, the network, or a block. Re-run the
   workflow by hand (`workflow_dispatch`, `limit` 5) before reading anything into it.
6. Close the issue with one line saying which of the above it was.

## The corpus

Public institutions and large companies in Denmark, Germany and the Union, chosen
because their home pages change slowly and because they are the sites a small company
compares itself with. The target is two hundred; the seed is sixty-six. Sites are added
in the same shape (`host`, `country`, `sector`), never removed once excluded.

Anyone who asks to be left out goes on `exclusions` with the reason and the date, and
stays there. The check refuses a corpus where an excluded host is still active.

## The benchmark

The run also leaves `benchmark.json` beside the snapshots and in `fixtures/canary/`,
which the workflow commits: the date, how many sites were scanned, and how many open
findings each had. No host and no order. The case page reads it and says what share of
the watched sites have more open findings than the case, with the number of sites and
the date. Below thirty sites it gives no share, only how many sites it is waiting for.
`CANARY_BENCHMARK_FILE` points the site at another file; tests use it.
