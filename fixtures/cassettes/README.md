# Cassettes

Recorded network, replayed in tests. Nothing in CI touches the live internet: every
outbound HTTP call goes through `createRecordedFetch` from `@gc/config`, and in `replay`
mode — the default, and what CI runs — the answer comes from a file in here. A missing
file is a hard error that names the cassette and the command to record it. It is never a
silent live call.

```
fixtures/cassettes/<name>/<METHOD>_<host>_<path>_<hash>.json
```

`<name>` is the adapter that made the call (`registry-cvr`, `corpus-eurlex`, …). The file
name is readable, and the hash covers the method, the full URL and the request body, so a
changed query is a new cassette rather than a stale match.

A cassette is plain JSON: the request as sent and the response as received, with
anything that looks like a credential replaced by `[redacted]` before it is written —
authorization and cookie headers, bearer tokens, API keys, JWTs. Review the file before
committing it anyway; it is a copy of a real response.

## Modes

| `GC_NETWORK` | Behaviour |
| --- | --- |
| `replay` (default) | Answer from the cassette. Missing cassette: error. No live call, ever. |
| `record` | Make the live call through the endpoint allowlist, write the cassette, return the answer. |
| `live` | Make the live call, write nothing. The nightly canary only. |

## Re-recording

```bash
GC_NETWORK=record pnpm test:integration -- <filter>
```

Then read the diff, and commit the cassettes with the change that needed them.
