# Handoff — build this end to end

You are picking up a project that has a finished design and an unstarted engine.
Read this file, then `CLAUDE.md`, then start work. Nothing else is required reading
up front; the rest is referenced when you need it.

## What this is

**GDPRcompliant.eu** — a free scanner for European companies that opens a numbered,
shareable **case**, answers every finding with something the customer can act on, and
keeps watching afterwards. Frits AI ApS, Copenhagen. Sister products: `gdprchat.eu`
(EU-hosted assistant) and `gdproffice.eu` (desktop agent).

The single sentence that decides most arguments: **everyone else hands European
companies a list of problems; this hands them a plan and the things that close it.**

## Where you are

**25 of 112 done.** Phase 0 is complete and signed off; phase 1 is 6 of 11 and phase 2 is
9 of 34. Contracts, config with the EU-only allowlist, the test harness, record and
replay, i18n, the remedy catalogue and resolver, the model client, the web shell, the
fixture estate (now with TLS), the browser pool, Pass A, cookie classification and the
security surface checks are in. The remaining phase 1 items (`F-02`, `F-03`, `F-05`,
`F-06`, `T-07`) all wait on a Postgres with pgvector, which needs Docker; see the notes
at the end of this file.

Do not trust that list — ask:

```bash
node scripts/tasks.mjs board     # the live picture
node scripts/tasks.mjs next      # what you can claim right now
```

Both read the task files directly, so they cannot drift from reality.

## Start here

```bash
git pull
node scripts/tasks.mjs next
node scripts/tasks.mjs show F-04            # read one in full before taking it
node scripts/tasks.mjs claim F-04 --as <your-name>
```

Then build it. When every acceptance criterion is genuinely met, tick the boxes in the
task file, run the `verify` command at the bottom of it, and:

```bash
node scripts/tasks.mjs done F-04 --note "one line on what shipped"
git add -A && git commit -m "F-04: shared contracts package" && git push
```

`done` refuses while any acceptance box is unticked. `claim` refuses when a dependency
is unfinished and names it. If a dependency is blocking you, that is the system working
— take something else rather than editing the graph.

## Working alongside other agents

Several agents can run at once. Claiming and closing touch exactly one file, so the task
files themselves almost never conflict. What does conflict is everything else.

**Pull before you claim, push as soon as you close.** A claim nobody can see is a claim
two agents will make.

```bash
git pull --rebase        # before claiming, and again before pushing
git push                 # immediately after `done`, not at the end of the day
```

If a push is rejected, `git pull --rebase` then push again. Do not force.

Four more rules that keep parallel work calm:

- **Never touch a task file you did not claim.** If `status: doing` and the owner is not
  you, leave it alone — even to fix a typo.
- **Shared files are where collisions actually happen**: `package.json`, `pnpm-lock.yaml`,
  `tsconfig.json`, `eslint.config.js`, `vitest.workspace.ts`. Touch them only when your
  task genuinely requires it, keep the change minimal, and push straight away.
- **Prefer tasks in different streams.** Two agents in `F-*` will meet in the root config;
  one in `F-*` and one in `U-*` will not.
- **A stale claim is worse than no claim.** If you stop working on something, run
  `release`, or `block` it with a reason. Do not leave it held.

Right now the six open tasks are genuinely independent, so up to three or four agents is
comfortable. Beyond that they will spend more time rebasing than building.

## The prototype is the design specification

`apps/prototype/` — a single zero-dependency page, twelve screens, driven entirely by
`fixtures/companies/eksempelbutik.json`.

```bash
node apps/prototype/smoke.mjs     # 430 assertions
node apps/prototype/build.mjs     # → dist/prototype.html, opens from disk
```

Two things carry forward and must not be re-invented:

- **`apps/prototype/styles.css`** is the real design system. Port it to the app at
  `F-01` unchanged. Only the `.proto-*` chrome is scaffolding.
- **`fixtures/companies/eksempelbutik.json`** becomes a real test fixture in phase 2.
  Its shape is the contract.

The framework glue does not carry forward. It is vanilla on purpose.

## What the smoke test encodes

Read `apps/prototype/smoke.mjs` before changing any screen. It is not a formality —
each block is a product rule Frits corrected us on, turned into a check:

- A finding cannot exist without a remedy.
- The case page shows exactly one current step and at most one primary action.
- A clean site is a pass, never a failed test — a site with no cookies correctly has
  no banner, and must not be told off for it.
- Copy may not narrate the interface. Banned: "below", "above", "you just need".
- Quoted law must match the corpus character for character.
- A question field holds only the question; context lives in its own field.
- Agent prompts must name the real domain, paths and hostnames — never "this site".
- Every drafted message must be sendable in one click.

## The eight decisions that shape everything

1. **Phase 0 gates everything.** The graph enforces it.
2. **A finding without a remedy cannot be represented** — database constraint, not a
   guideline (`R-02`).
3. **The model never asserts a fact.** Deterministic code observes; the model explains,
   prioritises and drafts. Every claim carries evidence; every legal claim carries a
   citation that mechanically resolves (`A-07`).
4. **Everything the scanner reads is hostile input** — pages, policies and contracts are
   attacker-controlled by design (`A-10`).
5. **No article number in detector code.** Findings have a stable identity; the article,
   authority and guide text are jurisdiction-scoped bindings (`I-02`). This is what makes
   the product European rather than Danish.
6. **Tenant isolation is proven, not assumed** (`F-05`, `T-07`).
7. **Never claim certification.** No seal, no "approved", no naming a third-party vendor
   as unlawful (`O-03`).
8. **Self-service first.** A consultant must never answer what the tool could have
   answered. Escalation is a last resort, offered plainly as a paid meeting (`V-04`).

## Reference documents

| | |
|---|---|
| `PLAN.md` | Architecture, stack decisions, repo layout, critical path, known risks |
| `TESTING.md` | Nine test layers and the delivery gate. The client cannot test this by hand — that constraint drives the whole strategy |
| `CLAUDE.md` | The working agreement. Rule 9 on copy is the one most often violated |
| `docs/decisions/dive-points.md` | How the chat-from-any-element mechanism works, read from the GDPRchat source |

## Working rules

Claiming and completing touch exactly one file, so parallel agents never collide.

```bash
node scripts/tasks.mjs claim <id> --as <name>
# work
node scripts/tasks.mjs done <id> --note "what shipped"
```

`done` refuses while acceptance criteria are unticked. `claim` refuses when a dependency
is unfinished and names it. A task whose tests were deferred is not done, it is blocked.

If the plan is wrong, say so in the task log and raise it — do not silently build a
different architecture. The plan is a hypothesis, but it is a shared one.

## Notes from the session of 3 September 2026

- **`F-02` is blocked on this machine, not on the plan.** Docker Desktop would not bring
  its engine up (the docker-desktop WSL distro stayed stopped) and later crashed. The
  local Postgres 17 has no pgvector. Everything downstream of `F-02` needs a database:
  start there when Docker works, or point `DATABASE_URL` at any Postgres 16 with pgvector.
- **The web app builds with webpack, not Turbopack.** The packages use NodeNext resolution
  (imports name `.js`, sources are `.ts`); webpack maps one to the other via an extension
  alias in `apps/web/next.config.ts`, Turbopack does not yet. The scripts pass `--webpack`.
- **Two EU hosts are assumed and not yet stood up:** `data.gdprcompliant.eu` for the Open
  Cookie Database (upstream is GitHub, outside the EEA) and the model endpoint declared via
  `ENDPOINTS_EXTRA`. See `packages/config/endpoints.json` and `.env.example`.
- **Playwright's Chromium is installed locally** (`pnpm exec playwright install chromium`);
  CI needs the same step before the integration and e2e suites.
- **The lazy-tracker fixture expects `CNS-01`, which has no catalogue remedy yet.** `S-05`
  or `R-03` must add one before `R-02`'s completeness check is switched on.
- **Danish is optional in `packages/i18n/content/locales.json`** until `R-03` fills it; flip
  `required` then and the coverage check will hold the line.
- **The fixture estate speaks TLS.** The proxy terminates CONNECT tunnels with a
  certificate it generates at start-up; pools and contexts that use it pass
  `ignoreHTTPSErrors: true`. A host can opt out with `tls: false` on its `FixtureHost`.
  A CONNECT to any port other than 443 is a plain tunnel, because Playwright's request
  context tunnels plain HTTP that way.
- **Unit-only coverage is carrying browser-bound code.** `pnpm test:coverage:check` runs
  the unit project alone, and `packages/scanner`'s pool, passes and checks are only
  exercised by integration tests, so the global figure has slid from 98% to 76% against a
  70% floor. Either run coverage across unit and integration in CI (a browser is there
  anyway) or exclude those modules from the unit denominator; decide before the next
  scanner task lands.
