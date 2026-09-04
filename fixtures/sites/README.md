# Fixture sites

Deliberately broken websites, served locally, each isolating known violations. They are
the ground truth the scanner is measured against, and the substitute for a human tester.

```
fixtures/sites/<name>/
  expected.json               what must and must not come out
  hosts/<host>/index.html     the site itself, and every third party it loads
  hosts/<host>/_routes.json   optional per-path overrides: redirects, headers, statuses
  golden.json                 everything the scanner raised here when last accepted (T-02)
```

Every host a fixture loads — the site, its consent platform, its trackers, its font
CDN — is a directory under `hosts/`, served by the fixture server. The browser is pointed
at that server as its HTTP proxy, so `http://analytics.tracker.test/tag.js` is answered
from `hosts/analytics.tracker.test/tag.js`. A host that is not in the fixture gets a 502,
TLS tunnels are refused, and loading a fixture whose files mention a host it does not
simulate fails before anything runs. Nothing in this directory can reach the internet.

Plain HTML, CSS and JavaScript only. No build step, no framework, no package manager.
Use the `.test` top-level domain: it is reserved and never resolves.

## expected.json

Validated by `FixtureExpectationSchema` in `@gc/contracts`.

```json
{
  "site": "eksempelbutik.test",
  "description": "Rejecting cookies leaves the trackers running.",
  "tags": [],
  "findings": {
    "must": ["CNS-02"],
    "mustNot": ["FRM-02", "SEC-02", "VND-06"]
  },
  "network": {
    "firstLoad": {
      "mustContact": ["consent.cmp.test", "analytics.tracker.test"],
      "mustNotContact": []
    },
    "afterReject": {
      "mustContact": ["analytics.tracker.test"],
      "mustNotContact": []
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `site` | The customer's host: the one the scan is pointed at. Must be one of the `hosts/`. |
| `description` | One sentence on what the fixture isolates. |
| `tags` | The awkward cases it covers: `clean`, `lazy-load`, `shadow-dom`, `iframe`, `spa`, `local-storage-consent`, `cloaking`, `injection`, `adversarial`. A fixture tagged `adversarial` is hostile by design (T-06): the estate-wide suites skip it and the adversarial suite runs it. |
| `findings.must` | Finding types that must be raised. Stable ids, e.g. `CNS-02`; never an article. |
| `findings.mustNot` | Finding types that must not be raised. This is what keeps false positives honest. |
| `network.firstLoad` | Hosts the browser must, and must not, contact on the untouched first load (pass A). |
| `network.afterReject` | The same after refusing consent (pass B). Optional until S-03 can drive the banner. |
| `network.afterAccept` | The same after accepting (pass C). Optional until S-04. |

A clean site is a fixture too: `findings.must` empty, the finding types it is proving
absent in `mustNot`, and `tags: ["clean"]`.

## _routes.json

```json
[{ "path": "/kontakt/send", "status": 301, "headers": { "location": "http://shop.test/kontakt/done" } }]
```

Paths not listed are served from the files. A listed path answers with the status and
headers given, and the optional `body`.

## Running

```bash
pnpm test:unit -- fixture-sites          # every fixture loads and validates; no browser
pnpm test:integration -- fixtures        # served through a real Chromium, expectations checked
```

Adding a fixture is a new directory. No code changes.

## golden.json

Where `expected.json` says what must and must not come out, `golden.json` records everything
that did come out, finding by finding, when someone last accepted it. `pnpm test:integration --
goldens` scans every fixture and names exactly what is missing, extra or changed against it.
A golden changes only on purpose: `pnpm goldens:update` rewrites them and prints what changed,
and because the files are committed, the change is a diff a reviewer reads next to the code
that caused it. A silently drifting scanner cannot pass.
