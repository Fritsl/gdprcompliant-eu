# GDPRcompliant.eu

A free European scanner that opens a shareable case and answers every finding with a
solution. Concept document: see the published artifact. This repo is the build.

## Status

Phase 0 — nothing claimed yet. `X-01` is the only task open, by design.

```bash
node scripts/tasks.mjs board     # where everything stands
node scripts/tasks.mjs next      # what can be started right now
```

## For humans

- **`PLAN.md`** — architecture, decisions, repo layout, the critical path, known risks.
- **`TESTING.md`** — how this gets verified without you testing it by hand.
- **`CLAUDE.md`** — the working agreement every agent reads first.

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
