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

**93 of 112 done.** Phase 0, phase 1 and phase 2 are complete, phase 3 has begun, DNS
collection opens phase 4 and the task catalogue opens phase 5. Contracts, config with the
EU-only allowlist, the test harness, record and replay, i18n, the remedy catalogue and
resolver, the model client, the web shell, the fixture estate (with TLS), the browser
pool, Pass A, cookie classification, the security surface checks, policy discovery, the
form inventory, replay and fingerprinting detection, the database harness, the schema
spine, the finding-needs-a-remedy constraint, row-level security with a per-transaction
tenant context, the durable job queue, the demand ledger, the case object with numbering,
tokens and claiming, the append-only timeline with its PDF, the case state machine, export
and hard delete, retention with its nightly sweep, the typed task catalogue with its
budgeted dispatcher, roles with scoped lists, the tenancy matrix that runs on every push,
DNS collection with its curated service map, certificate transparency enumeration,
invitations from a colleague, shared progress, the evidence pack, the corpus with exact
citation resolution behind a jurisdiction filter, the citation audit over the GDPR and
ePrivacy texts as published, the verifier gate with its review queue, the prompt-injection
defences (fenced untrusted content, output guards, the injection fixture), the
jurisdiction binding tables with their generated lawyer's document, the jurisdiction
matrix suite with the raise-and-store path it needed, cases that take their jurisdiction
and language from the target, the human sign-off gate on generated documents, the Article
13 clause analysis with its twelve labelled policies, consent banner detection with
refusal-path automation over eight banner fixtures, the Pass B and Pass C collectors that
check a choice was registered, the three-pass differ that raises the seven consent
findings with the hosts named, finding assembly with the severity table and re-scan
reconciliation, the re-check and weekly watch loop, the front door with the scan worker
(apps/worker, `pnpm worker:start`) that runs it, the nightly performance budget, the case
page with its evidence drawers, and the remedy interactions (copy, a re-check job that
reports what the scanner saw, artefact preview and sign-off, products labelled as ours),
and the opt-in public progress page (dated, never a seal, a count of what is open), and
the share flows (inward in the inviter's name, upward as a revocable one-screen summary
link, outward as that page), and the status report (a greyscale PDF at any moment: the
matrix with not-determined as its own state, numbered actions with owner and effort, every
provision quoted in full from the corpus), and the remedy guides (one structured content
object per finding rendered in English and Danish, every snippet proved in a browser
against a fixture that starts broken and ends fixed, `pnpm check:guide-snippets` on every
push), and claim discipline (a banned-claim vocabulary per locale read over every content
string, `pnpm check:claims` on every push; a finding about a third party cites a decision
in every jurisdiction; one disclaimer on the case page and in every export), and the guide
pages as a search surface (generated at build for every locale a guide is written in,
canonical and hreflang in the head, a sitemap and robots file, the scan form at the end of
every page), and the vendor registry (contracting entity and ultimate parent apart,
provenance and a review date on every entry, hosts resolved through the maps or left
unresolved with the host shown, `pnpm check:registries` warning on staleness), and the
transfer determination (adequacy list and Data Privacy Framework lookups as dated data,
hosted-in-the-EEA told apart from controlled-from-outside in the finding text, the policy
read for a Chapter V basis, every statement passing the claim vocabulary), and the case
graph (typed nodes and edges with origin, confidence and time on every row, contradictions
kept and surfaced until a person decides, the register as a projection), and the register
seeded from evidence (draft rows from the forms and the recipients, each citing its
evidence, confirmed with corrections by a person, exported as an Article 30 record in the
case's language, 2 edits from the drafts against 20 from nothing on the fixture estate),
and the privacy policy and cookie declaration generators (written from the graph without a
model, every paragraph tracing to its rows, refusing while the register has gaps and
naming them, in the case's language with its authority), and the drift check (the
published policy's traced recipients against every host the watch sees, a POL-05 finding
that names both sides within one watch cycle, nothing on a cosmetic change), and the
workers (crawler, contract reader, registry adapter, researcher, drafter and claim
verifier, each built from the narrowest tools handed in, returning claims on evidence and
never a verdict, proven in isolation and under the dispatcher), and the obligations engine
(rules as JSON with a citation and a worked example each, a fact sheet derived from the
register, three-valued evaluation that is total and deterministic, twelve rules across EU,
DK and DE, `pnpm check:rule-citations` on every push), and the planner (a fixed heuristic
sequence over the case state, a model planner held to the catalogue, the guards and the
budget, retried once then escalated with the heuristic standing in, a rationale on every
task, twenty scenarios measured), and the business registry adapters (one interface, CVR
and the Handelsregister via OffeneRegister.de, terms and pace documented and kept, unknown
where the register is silent, one contract suite over every adapter through recorded
cassettes), and sector inference with question selection (a sector from the register code
or the site, questions as content that declare what they settle, selection as the engine
run backwards so nothing derivable or answered is asked, every selection explained in the
reader’s language), and the one-question-at-a-time screen (one form per option, every
answer on the timeline as the holder with what it settled, check it for me queued as a
research task, answers revisable with every version kept), and lane routing (seven signals
from public facts, each with its reason, scored and stored with the case, never exported
or shown, gating nothing), and the commercial queue (signal × severity × what we can
solve, three lines of why per row, every row opening with a finding), and the consultant
view (a brief generated from the case, every internal opening on the customer’s timeline
by name, nowhere private to write), and the app listing check (the app found from the
site’s own store links, what the store declares held against the policy in three
languages, a contradiction quoting both sides, no app a clean pass), and job advert stack
extraction (the careers page from the site’s own links, a tool claimed only when named as
written, every candidate resting on the advert with its address and date, measured over a
twelve-advert set with no false claim), and observability (spans, events and metrics as
redacted JSON lines; a scan reconstructed from its job id; model latency and tokens per
call; the verifier rate as the dashboard number with its alarm) are in. The journeys suite
(tests/e2e/journeys.test.ts) drives a real scan of the estate through the front door, a
fix applied by changing the fixture's responses, a colleague's re-check, a sign-off, an
export and a deletion, and CI runs every e2e suite on push, files one at a time because
the pg-boss queue is shared across test schemas; The register page (draft rows from the
scan, one form to confirm a row with its retention, the record as a download, the count on
the case page) closes journey 2; T-09 stays blocked on A-06 and D-10 for journey 3 alone.
The adversarial suite now covers seven injection surfaces, cloaking (a browser against the
declared scanner, CLK-01), exhaustion (loops, stalls, huge pages, an archive bomb) and
server-side request forgery (an egress guard in the browser pool that judges every hop),
against six hostile fixtures tagged `adversarial`. The fixture suite
(tests/integration/fixture-suite.test.ts) scans all twenty-six fixtures as cases and holds
each to its expected.json, with four clean controls that must raise nothing and a coverage
check that every page-raised finding type has a positive and a negative; each fixture also
carries a committed golden.json, and the goldens suite names what is missing, extra or
changed and only rewrites under pnpm goldens:update. Twenty-six finding types are complete
end to end (detector, fixtures, bindings, remedy, guide in English and Danish, a line in
the generated docs/findings.md), with a recipients family that raises transfers outside
the EEA and third-party fonts, and public guide pages at /[locale]/guides. The database is
up (`pnpm db:up`); nothing in phase 1 is open.

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

- **Docker Desktop does not work on this machine; Docker Engine runs inside WSL Ubuntu.**
  Windows here cannot manage the Unix-socket files Desktop creates at start-up (every one
  becomes "The file cannot be accessed by the system" the moment its process dies), so the
  backend crashes on launch. The engine in WSL listens on `127.0.0.1:2375`; the Windows
  `docker` CLI uses context `wsl-engine`; `.env` sets `COMPOSE_CONVERT_WINDOWS_PATHS=1` and
  WSL has `/c -> /mnt/c` so bind mounts resolve. Desktop's autostart entry was removed and
  it is otherwise untouched; two `*.stale.*` directories under `%LOCALAPPDATA%\Docker` can
  be deleted from WSL (`rm -r /mnt/c/Users/frits/AppData/Local/Docker/run.stale.*`). If the
  engine is down after a reboot: `wsl -d Ubuntu -u root -e systemctl start docker`.
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
