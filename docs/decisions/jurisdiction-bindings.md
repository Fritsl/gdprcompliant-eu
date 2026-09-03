# Jurisdiction bindings: a finding is the same finding everywhere

A finding type (`CNS-02`, `SEC-03`, …) is an identity: what the scanner observed. What it
rests on in law, who would hear a complaint about it, and which guide explains it are a
*binding*, scoped to a jurisdiction. The bindings are content, one file per jurisdiction
in `packages/findings/content/bindings/`, and `docs/bindings.md` is rendered from them so
a lawyer can review the whole table without reading code.

## Rules

- **Detector code names no article.** `tests/unit/findings/jurisdiction-bindings.test.ts`
  scans the scanner and the finding registry for instrument names, article and paragraph
  references, and authority names. The only place an article appears is a binding row.
- **Every citation resolves.** A row's citations are written as a lawyer writes them
  (`GDPR`, `Art. 7(3)`), parsed into typed citations, and resolved against the corpus for
  the row's jurisdiction by `pnpm check:citations`. A national instrument is cited only
  once it is in the corpus; until then a table cites Union law.
- **Every promised type is bound everywhere the product speaks.**
  `pnpm check:finding-completeness` fails on a detector, a fixture expectation or a
  catalogue remedy whose finding type has no binding in a supported jurisdiction.
- **An unsupported jurisdiction fails, explicitly.** `bindingFor('CNS-02', 'FR')` throws
  `UnsupportedJurisdiction` naming what is supported. Nothing falls back to Danish or
  German law, and `EU` is not a jurisdiction a case can be in.
- **A national court speaks first at home.** Where a jurisdiction's own court has decided
  the point, its decision is the first citation in that table; elsewhere it follows the
  Union provision.

## Reviewing a table

Edit the JSON, set `reviewed` to your name and the date, bump `version` when the meaning
of a row changes (a finding carries the version it was bound with, so an old finding stays
explicable), run `pnpm bindings:doc`, and commit the table with the document.
