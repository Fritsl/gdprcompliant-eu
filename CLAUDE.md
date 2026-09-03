# GDPRcompliant.eu — working agreement

Read this before touching anything. It is short on purpose.

## Where things are

| | |
|---|---|
| `PLAN.md` | Architecture, decisions, repo layout, phases. Read the sections you're touching. |
| `TESTING.md` | The test strategy. Non-negotiable — the client cannot test this by hand. |
| `tasks/*.md` | One file per task. The source of truth for what is claimed and done. |
| `tasks/_seed.mjs` | How the task files were generated. History, not truth. |
| `scripts/tasks.mjs` | The coordination CLI. |

## How to pick up work

```bash
node scripts/tasks.mjs next          # what is claimable right now
node scripts/tasks.mjs show X-01     # read it in full
node scripts/tasks.mjs claim X-01 --as <your-name>
```

Then work. When every acceptance criterion is genuinely met, tick the boxes in the task
file, run the `verify` command, and:

```bash
node scripts/tasks.mjs done X-01 --note "one line on what shipped"
```

If you get stuck: `node scripts/tasks.mjs block X-01 --reason "..."` and move on. If you
claimed something and did nothing: `release`.

**Claiming and completing touches exactly one file**, so parallel agents rarely collide in
git. Never batch-edit other people's task files.

If others are working at the same time: `git pull --rebase` before you claim, and push
the moment you close — a claim nobody can see is a claim two agents will make. The full
set of rules is in `HANDOFF.md` under *Working alongside other agents*.

## Rules that are not negotiable

1. **The prototype is the design specification.** Phase 0 is built and signed off, so the
   graph is open — but `apps/prototype/` is now the reference, not a sketch. Its
   `styles.css` is the real design system and ports unchanged; the fixture at
   `fixtures/companies/eksempelbutik.json` becomes a real test fixture in phase 2 and its
   shape is the contract. Read `apps/prototype/smoke.mjs` before changing any screen: its
   430 assertions are product rules, not formalities, and CI runs them on every push.

2. **A finding without a remedy cannot exist.** Not a guideline, a database constraint
   (`R-02`). If you are adding a detector, you are also adding a remedy in every supported
   jurisdiction, or the CI check fails.

3. **The model never asserts a fact.** Deterministic code observes; the model explains,
   prioritises and drafts. Every claim entering the graph carries an evidence pointer, and
   every legal claim carries a citation that mechanically resolves to a real paragraph. The
   verifier gate (`A-07`) is the enforcement point. One hallucinated citation in a document
   a customer forwards to their lawyer is an existential problem, not a bug.

4. **Everything the scanner reads is hostile input.** Page text, policies and contracts are
   attacker-controlled by design. They are data, never instructions (`A-10`). If you write a
   prompt that includes scraped content, it must be delimited and labelled as untrusted, and
   there must be an adversarial fixture proving injection fails.

5. **No article number in detector code.** Findings have a stable identity; the article, the
   authority and the guide text are jurisdiction-scoped bindings (`I-02`). This is what makes
   the product European instead of Danish. If you hardcode Danish law, you have broken the
   architecture.

6. **Tenant isolation is proven, not assumed.** Row-level security on every table, and a test
   that actively tries to cross the boundary (`F-05`, `T-07`).

7. **Never claim certification.** No seal, no badge, no "approved", no "GDPR compliant" as a
   verdict about a customer. And never characterise a named third-party vendor as unlawful —
   describe observable behaviour and cite a decision. A build-time phrase check enforces this
   (`O-03`).

8. **Tests come with the task, not after it.** Every task's `verify` line is its definition
   of done. A task whose tests were deferred is not done, it is blocked.

9. **Write for the reader, not about the product.** Every line of user-facing text must
   either tell someone something they do not know, or let them do something. Text that
   describes the control sitting next to it, or explains why we built something the way we
   did, gets deleted — not shortened.

   | Never write this | Why it is dead weight |
   |---|---|
   | "Each one is a single tap, and you can always say 'check it for me' instead." | The buttons are visible directly underneath. |
   | "We only ask what we cannot work out ourselves." | Justifying ourselves to someone who never complained. |
   | "Type your address below." | They can see the field. |
   | "This is normal — it's why we keep looking every week." | Explaining our business model to a customer. |
   | "It never says approved, certified or compliant." | A note to ourselves that escaped into the product. |
   | "We've written them — you just need to read them and say yes." | The second half narrates the button. |

   Two specific rules that follow from it. **A statement and a question never share a
   sentence** — what we already know goes in its own field and is rendered separately, so
   the question stands alone and is unmistakably the question. And **when a paragraph
   exists to explain a design decision, replace it with the control it was describing**:
   the colleagues screen lost an essay about why invitations come from a colleague and
   gained a list of who has not finished, with Invite and Remind.

   The narration guard in `apps/prototype/smoke.mjs` fails the build on the most common
   forms ("below", "above", "on this page", "you just need"). Extend that list when you
   find a new one; do not argue with it.

## Conventions

- TypeScript, strict. `pnpm` workspaces. Zod for every boundary schema, defined once in
  `@gc/contracts` and imported everywhere else.
- No network in unit tests. Integration and e2e run against recorded cassettes (`F-09`);
  a missing cassette in CI is an error, never a live call.
- Commit messages reference the task id: `X-04: case page timeline and progress track`.
- If the plan is wrong, say so in the task log and raise it — don't silently improvise a
  different architecture. The plan is a hypothesis, but it's a shared one.
