# Observability

What the system says about itself (O-04), and where to look.

## What is emitted

Every record is a JSON line on the worker's stdout, written by `@gc/telemetry`, and
passes the redactor first. There are three kinds.

| Kind     | Name                 | Emitted by                                  | Carries                                                       |
| -------- | -------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| `span`   | `job.run`            | `@gc/jobs` around every handler             | job name, job id, attempt, duration, outcome                  |
| `span`   | `scan.job`           | the scan worker                             | job id, domain, attempt, duration, outcome                    |
| `event`  | `scan.stage`         | the scan worker at every checkpoint         | scan id, stage, mark, detail                                  |
| `span`   | `agent.task`         | the dispatcher around every task            | task type, task id, scan id, credits, attempt, outcome        |
| `event`  | `model.call`         | the model client on every attempt           | call, attempt, HTTP status or `transport`, latency, tokens    |
| `metric` | `model.latency_ms`   | the model client                            | tagged by call                                                |
| counter  | `model.calls`        | the model client                            | tagged by call and ok                                         |
| counter  | `model.tokens`       | the model client                            | tagged by call and kind (`prompt`, `completion`)              |
| counter  | `verifier.claim`     | the verifier on every verdict               | tagged by verdict and claim kind                              |
| `event`  | `verifier.verdict`   | the verifier                                | claim id, kind, verdict, the checks and how they went, reason |
| `event`  | `worker.up`          | the worker process                          | concurrency                                                   |

## The trace of a scan

The job id is the trace id. Everything a scan does lands on it: the `job.run` span from
the queue, the `scan.job` span from the worker, one `scan.stage` event per checkpoint
in the order the stages ran (`opening`, `first-load`, `banner`, `refusing`,
`after-refusal`, `accepting`, `policy`, `recipients`, `security`, `writing-up`), and
every `agent.task` span the planner dispatched for it. Filter the log by `traceId` and
the scan reads back end to end; `tests/integration/observability.test.ts` does exactly
that against the fixture estate.

## Cost and latency per task type

A task's cost is what its model calls used. `model.latency_ms` is a histogram per call
name; `model.tokens` counts prompt and completion tokens per call name; `agent.task`
spans carry the credits the planner priced the task at. Sum the tokens under a task's
trace to see what it cost; compare `model.latency_ms` across call names to see where
the time goes.

## The verifier rate

`verifier.claim{verdict}` counts every verdict the gate gives. The rate to put on the
dashboard is `rejected / (accepted + rejected)`, which `verifierRejectionRate()` in
`@gc/telemetry` computes from the registry. The gate rejects some share of claims every
day, because the model is a model. A sudden drop towards zero is not the model getting
better; it is the gate no longer gating.

**Alarm:** over any rolling 24 hours with at least 50 verdicts, a rejection rate below
1% pages the on-call. So does a rate above 60%, which means the corpus or the evidence
store moved under the verifier.

## What never appears

The redactor drops any field named for a person or a secret (name, e-mail, phone,
address, IP, token, authorization, cookie, password), any field that carries page text
or a body (`text`, `html`, `body`, `raw`, `quote`, `content`, `answer`), scrubs e-mail
addresses, Danish personal numbers, phone numbers, IPv4 addresses, bearer tokens and
JWT-shaped strings out of every string value, cuts query strings off URLs, and
truncates any string past 300 characters. The integration test scans every line a
scan produced for all of those patterns, and for the redaction of a deliberately
planted record.

The log is operational, not evidential: the case's evidence lives in the database
under row-level security, hashed and content-addressed. Nothing here is a copy of it.
