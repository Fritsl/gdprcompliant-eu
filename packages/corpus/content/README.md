# Corpus content

One JSON file per instrument, validated by `CorpusDocumentSchema` in `@gc/contracts`:
the instrument id (`GDPR`, `ePrivacy`, `DK-DBL`, …), its title, the jurisdiction it
speaks in (`EU` for Union law, a country code for a national act), the corpus version
it was cut at, where the text was retrieved from and when, the date the consolidated text
speaks from (`source.textAsOf`; an instrument without one cannot be quoted), and the chunks: one per
article, one per paragraph, one per point, each with the article and, where it applies,
the paragraph number and point letter. A chunk's key is
`instrument:article[:paragraph[:point]]`, and it is unique within a file.

A citation resolves against these chunks and nothing else: the exact key or a typed
failure, never the nearest match. Retrieval by similarity runs over the same chunks in
the database, filtered to `EU` plus the case's own jurisdiction.

## Union instruments

`sources.json` lists the instruments taken from the Publications Office cellar (the
store behind EUR-Lex) by CELEX number. `pnpm corpus:ingest` fetches each through the
recorded fetch, cuts it, and writes `<instrument>.json`. The cassettes under
`fixtures/cassettes/corpus-cellar` are the Official Journal text as served, and a unit
test re-cuts them and compares to the committed file, so the content cannot drift from
its source. To take a newer text, run the ingest with `GC_NETWORK=record` and commit the
cassettes with the content.

| Instrument | Source | Chunks |
| --- | --- | --- |
| `GDPR` | Regulation (EU) 2016/679, CELEX 32016R0679 | articles, paragraphs and points; recitals not yet |
| `ePrivacy` | Directive 2002/58/EC as consolidated on 19 December 2009, CELEX 02002L0058-20091219 | articles, paragraphs and points |

Definitions numbered in brackets (`(11)` in Article 4) are cut as paragraphs, which is
how they are cited: `Art. 4(11)`.

## Decisions

`decisions.json` is the registry of court and authority decisions the content may cite:
the body, the case number, where the body sits, the law it read (`scope`: `EU` for a
judgment on Union law, a country code for one on a national act), the date, and where
the text was read. A decision citation resolves to an entry or fails. An entry without
`text` cannot confirm a quote, and the audit says so rather than accepting it.

## The audit

`pnpm check:citations` walks every content file (remedies, findings, artefacts, i18n,
the web copy, the company fixtures), finds every citation in it, resolves each here and
confirms each quote by exact substring. It runs in CI on every push.

`TEST-REG` and `TEST-DK` are synthetic instruments for the test suite. They exist so the
mechanics can be proven without a claim about real law.
