# Recorded DNS answers

One file per domain, `<domain>.json`, with the TXT, MX and CNAME answers the collector
asked for. Replay mode (the default, and the only mode in CI) reads these and never asks
a resolver; a domain without a file is an error. `GC_NETWORK=record` asks the system
resolver and writes the file; `GC_NETWORK=live` asks and writes nothing.

`eksempelbutik.test` is synthetic: a `.test` domain never resolves, so the file is the
only place its records exist. It carries the shapes the collector must handle: an SPF
record with known and unknown includes, verification tokens both mapped and not, a
registrar's stray prose, DMARC, MX exchanges mapped and not, and CNAMEs under
mail-shaped labels.
