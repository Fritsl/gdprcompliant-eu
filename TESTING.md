# Testing strategy

The premise of this document: **the client will not test this by hand, and shouldn't have
to.** Everything a careful human tester would catch has to be caught by something that runs
on every push. Where that's genuinely impossible, it goes on a manual checklist of under
fifteen items (`T-12`) — and that list stays small by treating every addition to it as a
failure of automation.

This is harder than usual for three reasons. The system reads the live internet, which
changes. It uses a language model, which is non-deterministic. And it makes claims about the
law, where being confidently wrong is worse than being silent.

---

## Nine layers

### 1 · Fixture sites — the ground truth (`T-01`, `F-07`)

Twenty-five deliberately broken websites, served locally, each isolating known violations,
each with an `expected.json` naming exactly which findings must appear **and which must
not**. This is the substitute for a human tester, and its coverage is the ceiling on how far
anyone can trust the scanner.

At least four fixtures are *clean* sites that must produce zero findings. A scanner that
cries wolf on a compliant site is worse than no scanner, and negative fixtures are the only
thing that keeps false positives honest.

The awkward cases matter more than the easy ones: lazy-loaded trackers, banners in shadow
DOM, consent stored in localStorage rather than cookies, single-page apps, iframes.

### 2 · Deterministic replay (`F-09`)

Nothing in CI touches the live internet. Every HTTP, DNS and registry call goes through a
recorder; CI replays committed cassettes and blocks egress entirely. **A missing cassette is
a hard error, never a silent live call.** A flaky suite is a suite nobody trusts, and an
untrusted suite defeats the entire premise of this document.

### 3 · Citation resolution (`T-03`) — the hallucination gate

Every citation the system can emit, in every rule, remedy, guide and generated document, is
mechanically resolved against the corpus. Quoted text is confirmed present at that location
by exact substring match — **in code, not by asking a model.** Runs over the whole content
set in CI, not a sample.

This is the cheapest high-value test in the plan. A fabricated article number in a document
a customer forwards to their lawyer is the failure mode that ends the company, and it is
fully preventable by string comparison.

### 4 · Schema conformance (`T-04`)

Every model output validates against its Zod schema at the call site. Fuzzed and truncated
responses have defined behaviour: retry once, then fail loudly. A test enumerates model call
sites and fails if any lacks validation — so a new one can't slip through unguarded.

### 5 · Behavioural evals (`T-05`)

Where the model exercises judgement, exact-match testing is meaningless, so each judgement
site gets a labelled scenario set with a declared pass threshold:

| Set | Scenarios | Threshold |
|---|---|---|
| Policy clause analysis (`S-10`) | 12 policies, expert-labelled | ≥ 95% agreement |
| Processing agreement analysis (`D-06`) | 10 real-world agreements | ≥ 95% agreement |
| Planner next-action (`A-06`) | 20 graph states | ≥ 90% sensible |
| Verifier rejection (`A-07`) | 50 poisoned claims | ≥ 98% rejected |

Results are tracked over time, so a prompt change that quietly degrades quality is visible
rather than discovered by a customer. Evals run against the **self-hosted** configuration —
quality on a model you don't ship is not quality.

### 6 · Adversarial (`T-06`, `A-10`) — treat this as security, not prompt hygiene

This product reads attacker-controlled text by design. A malicious site can embed
instructions in visible text, HTML comments, alt attributes, CSS content, JSON-LD, the
privacy policy or the processing agreement. The suite covers all of them, plus:

- **Cloaking** — a fixture serving clean content to our user agent and trackers to everyone
  else. Must be detected and reported, not congratulated.
- **Resource exhaustion** — infinite redirects, enormous documents, slow responses, archive
  bombs behind links.
- **Server-side request forgery** — attempts to make the scanner reach internal addresses or
  act as an open proxy.

Any successful attack fails the build.

### 7 · Boundaries (`T-07`, `T-08`)

Tenant isolation is tested by actively trying to break it: cross-tenant reads, writes, joins,
aggregates, job payloads, export endpoints and invitation links, plus an authenticated user
of tenant A attempting every route belonging to tenant B. Runs on every push, not nightly.

The jurisdiction matrix scans one fixture as several countries and asserts identical finding
*identities* with different bindings — and that a Danish authority never appears in a German
case.

### 8 · Journeys (`T-09`)

The paths a person actually takes, driven through a real browser against the fixture estate:
scan → case opens → read a finding → fix it → re-check → watch it close. Invite a colleague
→ they finish their list → the register fills. Export the case, delete it, assert it's gone.

### 9 · The canary corpus (`T-10`) — what fixtures can never catch

Two hundred real, stable, public sites scanned nightly and compared day over day. Fixtures
prove the scanner does what we designed; the canary proves it still works on the actual
internet, where consent platforms change markup without warning.

The critical detail: when results shift, re-run the *previous* scanner build against the
same snapshot. That distinguishes "the site changed" from "we broke something" — without it
the alarm is noise and gets ignored within a fortnight.

---

## Invariants enforced at build time

Not tests of behaviour — structural properties that make whole categories of bug
unrepresentable:

- A finding cannot be persisted without a remedy (database `NOT NULL` + CI completeness check)
- A finding cannot be persisted without evidence
- A new table without a row-level-security policy fails lint
- A table without a declared retention rule fails CI
- An article number appearing in detector code fails lint
- A banned phrase — *certificate*, *approved*, *compliant* as a verdict — in customer-facing
  content in any locale fails the build
- Identical scans produce byte-identical finding sets

## The delivery gate (`O-05`, `T-12`)

One command, one verdict:

```bash
pnpm run gate
```

It runs every suite, compares the canary against its baseline, checks the invariants, and
prints a single pass or fail with a named owner and task id for anything red. It writes a
signed, dated report to `artifacts/`.

Nothing is handed over on a red gate. Not "red but we know why" — red is a stop.

## What stays manual

Under fifteen items, each a yes-or-no observation rather than a judgement call. Roughly: does
the case page read well printed; does the Danish sound like Danish; does the trust page look
like a seal to someone glancing at it; is the first screen on a phone actually usable. Things
that need eyes and taste — which is exactly why everything else must not.
