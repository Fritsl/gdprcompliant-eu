# When is a page finished loading?

Pass A loads a page and touches nothing. The question is how long to watch before
calling the capture complete, because the trackers that matter most are the ones that
arrive late: a tag manager that fires a pixel on a timer, a chat widget that boots after
the first paint, a session-replay script that waits for idle.

`waitUntil: 'networkidle'` in a browser automation library means half a second without
requests. A tag on a four-second timer sails past it, and the scanner would then tell a
site owner that nothing loads before consent when something plainly does.

## The heuristic

Three numbers, all in `PassCapture.quiet` so a reader can see what was used:

| | Default | Meaning |
| --- | --- | --- |
| `minDwellMs` | 5 000 | Watch at least this long after navigation starts, whatever happens. Timers of up to four seconds are common; five catches them with margin. |
| `quietMs` | 1 500 | After the floor, the network must be silent — no request in flight, none started — for this long. |
| `maxWaitMs` | 15 000 | Stop regardless. A page that never goes quiet (long-polling, a video) is captured as it stands, with `settled: false`. |

The pass ends at the first moment both the floor and the silence are satisfied, or at
the cap. `dwellMs` records how long it actually watched and `lastRequestAtMs` when the
last request began, so a finding can say "a request to X started 4.1 seconds after the
page loaded, before anything was clicked".

## What it does not do

It does not wait for timers it cannot see. A tag on a thirty-second timer is missed, and
that is a known limit rather than a bug: the weekly watch (`W-*`) sees the site again,
and the canary corpus (`T-10`) measures how often late loaders escape the window.

## Proof

`fixtures/sites/lazy-tracker` injects a tracker script four seconds after load. The
Pass A suite asserts the tracker's host is in the capture, and that the same fixture
loaded with `networkidle` alone would have missed it.

## Who asked for it

Each request carries Chromium's own attribution. A request a script made by inserting
an element or calling fetch is a `script` initiator with that script's URL, and the chain
follows script to script back to the document. A request the HTML parser made — and that
includes what a parser-blocking script does while the parser waits for it — is a `parser`
initiator with the document as URL and the line of the tag that caused it. Both are
exact; a finding can say "line 11 of your page loads X" or "tag.js loads X".
