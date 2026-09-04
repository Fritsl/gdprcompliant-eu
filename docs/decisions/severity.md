# Severity: one table, read the same way every time

A finding's severity is never a detector's call. It is computed in one place,
`severityFor` in `packages/findings/src/severity.ts`, from two pieces of content:

1. **The base**, per finding type, in `packages/findings/content/detectors.json`
   (`defaultSeverity`). This is what the type means on its own: a tracker that ignores a
   refusal is blocking, a missing referrer policy is advisory.
2. **The rules**, in order, in `packages/findings/content/severity.json`. Each names its
   condition and its effect, and the decision records which ones applied.

| Rule | When | Effect |
| --- | --- | --- |
| `observed` | the detector graded what it saw (a form's sensitivity, a replay tool on a payment page) | the higher of base and observed |
| `many-hosts` | a consent finding names three or more hosts | one level up |
| `sensitive-sector` | consent, collection or observation findings on a health or education site (NACE 85, 86) | one level up |
| `regressed` | the finding was closed and is back | one level up |

Levels are `advisory`, `serious`, `blocking`; raising past blocking stays blocking.

## Why a table

The prototype fixed severities by hand, per finding, and the reviewers could not say why
one was serious and another advisory. With the table, the answer is the row, and changing
a severity is a content change a lawyer can review, not a code change. The assembly test
asserts that the same scan assembled twice is the same bytes, so a severity cannot depend
on anything the table does not name.

## Adding a rule

Add it to `severity.json` with a description a reader can act on, add a case to
`tests/unit/findings/severity.test.ts`, and say in the task log which findings it moves.
