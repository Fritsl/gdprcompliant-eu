# Dive points

How GDPRchat's Zen "Dive deeper" actually works, and how it maps onto this product.

Read from `Fritsl/GDPRchat-v3` at `12af218` (3 Sep 2026):
`src/components/chat/zen-overlay.tsx` and `src/components/chat/message-bubble.tsx`.

## What it does, exactly

Zen mode segments one assistant answer into **cards** and shows them fullscreen, one at a
time. Each card carries a "Dive deeper" affordance. Pressing it does this and nothing more:

```ts
const plain = stripMarkdownForPrompt(card.content);
onStartNewSearch(`${labels.startNewSearchPrompt} ${plain}`);
// → handleZenStartNewSearch → setZenOpen(false) → fireSuggestion(text) → onSuggestionClick(text)
```

`onSuggestionClick` is the ordinary "the user typed a message" path. So:

**It appends a normal user turn to the same conversation. It does not start a new one.**

The message sent is literally `"Tell me more about this: " + <the card's text>`, localised
across 27 languages, with the card text put through `stripMarkdownForPrompt`: bold, italic,
links, headings, list markers and backticks removed, newlines collapsed, and **truncated to
300 characters**.

### The gating rules are the quiet part

`shouldShowStartNewSearch` refuses the affordance when:

- `index === 0` — the opening card, where "tell me more" means "repeat yourself"
- `card.type === "toolResult" || "heading"` — nothing to expand
- the content ends in `:` — a lead-in fragment, so the quote would be a dangling stub

and the button is not rendered at all when the card already carries follow-up chips, so a
card never offers two competing ways forward.

## Why it works — and why my first guess was wrong

I assumed it *re-rooted*: took the fragment, dropped the parent conversation, started a
fresh thread scoped tightly to that one thing. It doesn't, and the real design is better.

The model already holds the whole conversation. Quoting one fragment back as a new user
turn makes that fragment a **pointer** — it disambiguates which part of its own previous
answer "more" refers to, without discarding anything. Three consequences fall out for free:

1. **Retrieval re-scopes by itself.** It is an ordinary turn whose text is the fragment, so
   RAG runs against the fragment. No special retrieval path had to be written.
2. **Continuity survives.** Everything established earlier still applies, which is exactly
   what you want when the user is drilling into a detail of a larger answer.
3. **It is about fifteen lines.** No second endpoint, no summarisation, no context surgery,
   nothing to keep in sync.

The 300-character cap is what keeps the pointer a pointer. Quote an essay back and you have
not narrowed anything.

## What changes here

The same interaction, but our dive points sit on a **page**, not inside a conversation —
a finding title, a step, a phrase like *"refusing cookies"*, a quoted article, a matrix
cell. There is no prior conversation to append to, so the entry mechanics differ while the
feel stays identical:

| | GDPRchat | GDPRcompliant.eu |
|---|---|---|
| Origin | A card in an existing thread | Any element on any page |
| Prior context | Already in the thread | Must be supplied — this is the work |
| Mechanism | Append a user turn | Seed turn zero, then append |
| Retrieval | Re-runs on the new turn | Same |

So a dive from a page opens a conversation whose **turn zero** carries what the thread
would otherwise have carried:

- the fragment, treated exactly as above — stripped, capped, prefixed with the localised
  "Tell me more about this:"
- **the case as structured fact** — the finding, its evidence, and the relevant graph rows,
  passed as data with provenance, never as prose the model might treat as instruction
- **the corpus**, jurisdiction-filtered to the case's country

After turn zero it is an ordinary conversation, and any further dive inside it appends,
exactly as GDPRchat does today.

### Rules carried over unchanged

- No dive on an element with nothing to expand — a bare number, a date, a status pill
- No dive where the element already offers a specific next action; one way forward per thing
- The fragment is **data, not instruction**. It frequently comes from the customer's own
  website or contracts, which are attacker-controlled (see `A-10`), so it must be delimited
  and labelled as quoted material in turn zero.

### One thing worth stealing beyond the mechanism

Zen exists because a long answer read one card at a time is easier to take in than a wall.
Our step-by-step case page arrived at the same conclusion independently. Worth checking
whether the report and the supply-chain map want a Zen-style reading mode too, rather than
only the chat.
