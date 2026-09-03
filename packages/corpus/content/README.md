# Corpus content

One JSON file per instrument, validated by `CorpusDocumentSchema` in `@gc/contracts`:
the instrument id (`GDPR`, `ePrivacy`, `DK-DBL`, …), its title, the jurisdiction it
speaks in (`EU` for Union law, a country code for a national act), the corpus version
it was cut at, where the text was retrieved from and when, and the chunks: one per
paragraph or point, each with the article and, where it applies, the paragraph number
and point letter. A chunk's key is `instrument:article[:paragraph[:point]]`, and it is
unique within a file.

A citation resolves against these chunks and nothing else: the exact key or a typed
failure, never the nearest match. Retrieval by similarity runs over the same chunks in
the database, filtered to `EU` plus the case's own jurisdiction.

`TEST-REG` and `TEST-DK` are synthetic instruments for the test suite. They exist so the
mechanics can be proven without a claim about real law; real instruments are ingested
from their allowlisted sources (see `packages/config/endpoints.json`) with the text as
published, never typed in.
