# GDPRcompliant.eu — implementation plan

Companion to the concept document. That one argues *what* to build and why; this one says
*how*, in what order, and who can pick up which piece. 107 tasks across seven phases.

**Start here:** `CLAUDE.md` for the working agreement, then `node scripts/tasks.mjs board`.

---

## The shape of the work

| Phase | Name | Goal | Tasks |
|---|---|---|---|
| **0** | Prototype | Every screen clickable with nothing behind it. **Frits signs off before engine code exists.** | 10 |
| 1 | Foundations | A repo where a test can fail for the right reason. | 10 |
| 2 | The wedge | Public scanner live: three passes, 20 findings, every one with a fix. | 26 |
| 3 | The case | A numbered case that persists, shares and re-verifies. | 11 |
| 4 | Depth | Public record and the contract chain. The part nobody else does. | 12 |
| 5 | The system | Graph, rules, planner, verifier. It stops being a scanner. | 24 |
| 6 | Delivery | Everything green, canary stable, handed over. | 14 |

Phases overlap in calendar time but not in dependency. The graph is the truth —
`tasks.mjs next` will never offer you something whose foundations are missing.

### Why phase 0 exists

You asked to see the UI before the machinery, and you're right to. A compliance scanner is
mostly judgement calls about *what to show a frightened person* — how a finding is worded,
whether the evidence drawer reassures or overwhelms, what the case page feels like on day
one versus month three. Those decisions are cheap to change in a prototype and expensive to
change once detectors, schemas and rules have been shaped around them.

Phase 0 is deliberately non-functional: no database, no queue, no model calls, no network.
One shared mock dataset drives every screen so the story stays coherent — and that dataset
becomes a real test fixture in phase 2, so it isn't throwaway work. Neither are the
components: phase 0 builds the real design system in the real framework, and `F-01` absorbs
the app into the workspace without discarding anything.

`X-10` is the gate. Everything else in the plan depends on it transitively through `F-01`.

---

## Decisions taken, and why

**TypeScript everywhere, pnpm workspaces.** Playwright is first-class in Node and the
crawler is the heart of the product. One language across crawler, workers and web removes a
whole category of contract drift.

**Next.js, server-rendered.** The guide pages are a distribution strategy (one page per
finding type per locale — 120 pages at launch), so rendering on the server isn't optional.
The same app serves the case pages and the public trust pages.

**Postgres with pgvector, one database.** The case graph, the job queue and the corpus
embeddings all live in Postgres. Fewer moving parts to make sovereign, back up and reason
about. Drizzle for migrations — explicit SQL, no magic.

**pg-boss for jobs, not Temporal.** The concept document argued for durable workflow
execution and that's still right, but Temporal is a large operational commitment for a
six-week MVP. pg-boss gives durability, retries and resumability on infrastructure that's
already there. `F-06` keeps the job interface narrow specifically so this can be swapped
later without touching worker logic. Revisit when a case routinely spans weeks of waiting.

**Self-hosted models behind an OpenAI-compatible endpoint.** Configured as a base URL
(`F-10`), so the existing stack drops in and per-tenant isolation is a deployment concern
rather than an application one. Evals (`T-05`) run against the self-hosted configuration,
because quality on the model you actually ship is the only quality that counts.

**Rules as data, not code.** The obligations engine (`A-02`) evaluates a versioned,
human-authored rule set that a lawyer can review without reading TypeScript. Every rule
carries a citation that CI checks resolves. This is the difference between a product you
can defend in front of a customer's counsel and one you can't.

---

## Repo layout

Later tasks assume these paths. `F-01` establishes them; don't improvise alternatives.

```
apps/
  prototype/        phase 0 — non-functional UI, absorbed into web/ at F-01
  web/              Next.js — front door, case pages, trust pages, guides
  worker/           job runners
packages/
  contracts/        @gc/contracts — Zod schemas, the only definition of every shape
  db/               Drizzle schema, migrations, RLS policies
  scanner/          Playwright pool, the three passes, collectors
  findings/         detectors, severity, assembly
  rules/            obligations engine, rule DSL, rule sets per jurisdiction
  remedies/         catalogue, resolver, guide content
  agent/            planner, workers, verifier, task catalogue
  corpus/           retrieval with jurisdiction filter, citation resolution
  artefacts/        generators — policy, cookie declaration, DPA, register, evidence pack
fixtures/
  sites/            deliberately broken websites with expected.json
  cassettes/        recorded network for deterministic replay
  companies/        mock case datasets (phase 0's dataset lives here)
tests/
  unit/ integration/ e2e/ evals/ adversarial/ perf/
scripts/
  tasks.mjs         coordination CLI
  gate.mjs          the delivery gate (O-05)
  canary.mjs        nightly real-site drift check (T-10)
docs/
  schema.md findings.md decisions/
```

---

## The critical path

Not everything matters equally. If you only watch a handful of tasks, watch these:

1. **`X-10`** — the sign-off gate. Nothing moves until this closes.
2. **`S-03` banner detection and refusal automation.** The single hardest task in phase 2
   and the one the entire wedge rests on. When uncertain it must say "could not determine"
   rather than pass a site that was never tested.
3. **`A-07` the verifier gate.** Scheduled early, in phase 2, because `S-10` needs it. It is
   the load-bearing safety component of the whole product.
4. **`I-02` jurisdiction bindings.** Cheap now, a rewrite later. Skip it and the product is
   permanently Danish.
5. **`T-01` the fixture site suite.** Its coverage is the ceiling on how much anyone can
   trust the scanner — see `TESTING.md`.
6. **`R-02` the no-finding-without-a-remedy constraint.** Half a day, and it's what keeps
   the product from decaying into the problem-list tool we set out not to build.

## Known risks in the build itself

**Banner detection will be an arms race.** Consent platforms change markup constantly. The
canary corpus (`T-10`) is the early warning; budget ongoing maintenance rather than treating
`S-03` as finished.

**Entity resolution is a data problem wearing an engineering costume.** `S-07` and `D-01`
depend on curated registries that need review dates and upkeep. CI warns on staleness; that
warning needs a human owner.

**Eval sets rot.** `T-05` thresholds must be reviewed when the model configuration changes,
or they quietly become meaningless.

**Phase 5 is the one that slips.** The planner is genuinely hard. `A-05` ships with a
hard-coded task sequence first and `A-06` swaps the model in behind it — so phase 4 is never
blocked on the planner being good.

---

## Reporting

`node scripts/tasks.mjs board` is the status report. It reads the task files directly, so it
cannot drift from reality. Two rules keep it honest: a task is done only when its `verify`
command passes, and a task nobody is actively working is released rather than left claimed.
