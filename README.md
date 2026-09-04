# GDPRcompliant.eu

A free European scanner that opens a shareable case and answers every finding with a
solution. Concept document: see the published artifact. This repo is the build.

## Status

Every phase is built; `node scripts/tasks.mjs board` shows what stands, and `pnpm run gate`
says whether it is fit to hand over.

```bash
node scripts/tasks.mjs board     # where everything stands
node scripts/tasks.mjs next      # what can be started right now
```

## For humans

- **`PLAN.md`** — architecture, decisions, repo layout, the critical path, known risks.
- **`TESTING.md`** — how this gets verified without you testing it by hand.
- **`CLAUDE.md`** — the working agreement every agent reads first.

## The delivery gate

One command decides whether this is fit to hand over:

```bash
pnpm run gate
```

It runs the build invariants (types, lint, formatting, row-level security, citations,
claims vocabulary, registries, the generated documents), then every required test suite
under its time budget, then the canary comparison, and prints one verdict. Any red is a
stop, named with the task it belongs to and that task's owner. The report lands in
`artifacts/gate/` as markdown and JSON, dated, sealed with a hash over its own content and
the name of whoever ran it, with the manual smoke checklist (`docs/smoke-checklist.md`)
appended for ticking by hand.

What it needs on the machine:

- Node 22 and pnpm 9: `pnpm install`.
- Postgres with pgvector: `pnpm db:up` (Docker), and `GC_TEST_DATABASE_URL` set, for
  example `postgres://gc:gc@localhost:5432/gc_test`.
- Chromium for Playwright: `pnpm exec playwright install chromium`.
- A model endpoint, optionally: `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_CHAT`,
  `MODEL_EMBEDDING`. Without one the evals prove the pipeline against the labels and the
  report says the model was not measured.

`pnpm run gate -- --dry-run` prints the plan and what this machine can and cannot run,
and writes the report without executing anything. `pnpm run gate -- --only unit` runs one
step. Nothing is handed over on a red gate; the same command runs in CI on demand
(`.github/workflows/gate.yml`).

## For agents

```bash
node scripts/tasks.mjs next
node scripts/tasks.mjs claim <id> --as <your-name>
# ... work ...
node scripts/tasks.mjs done <id> --note "what shipped"
```

Read `CLAUDE.md` before your first claim. Claiming and completing touch exactly one file, so
parallel agents never collide in git.

## The one thing to know

The plan starts with a **non-functional UI** — every screen clickable, nothing behind it —
which Frits reviews and signs off (`X-10`) before any engine code is written. The dependency
graph enforces it: `F-01` depends on `X-10`. Don't route around the gate.

## The prototype (phase 0)

```bash
node apps/prototype/smoke.mjs     # 79 assertions across all ten screens
node apps/prototype/build.mjs     # → apps/prototype/dist/prototype.html
```

That output is a single self-contained file — open it from disk, or host it anywhere.
Ten screens driven by `fixtures/companies/eksempelbutik.json`, which phase 2 adopts as a
test fixture unchanged. Nothing is wired to anything; controls that would do something
say so when you press them.

`X-01`–`X-09` are done. `X-10` — Frits's sign-off — is open, and phase 1 stays blocked
until it closes.
