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

| | |
|---|---|
| Phase 0 · Prototype | **9 of 10 done.** Every screen built and clickable. |
| Phase 0 · `X-10` | **Open.** Frits's sign-off. Nothing downstream starts until it closes. |
| Phases 1–6 | 0 of 102. All blocked behind `X-10` through `F-01`. |

Run `node scripts/tasks.mjs board` for the live picture. It reads the task files
directly, so it cannot drift.

## Start here

```bash
node scripts/tasks.mjs next                 # what is claimable right now
node scripts/tasks.mjs show X-10
node scripts/tasks.mjs claim X-10 --as <your-name>
```

`X-10` is a review session with Frits, not code. If it is still open, your job is to
prepare that review, not to route around it. **`F-01` depends on `X-10` and the tool
enforces it** — do not edit the dependency to unblock yourself.

Once `X-10` closes, `next` will offer `F-01` and the graph opens from there.

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
