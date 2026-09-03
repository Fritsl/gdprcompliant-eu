# Exposed-path probing

The scanner looks at a site the way a stranger with a browser would, and no further. The
security surface check (`S-12`) includes a probe for files that should never be public:
a version-control directory, an environment file, a database dump left in the web root.
This is where a scanner could drift into something that looks like an attack, so the
rules are fixed here and enforced in code.

## The list

Twelve paths, `GET` only, no query string, no body, no credentials, one request each,
in `packages/scanner/src/checks/exposed-paths.ts`. A path counts as exposed only when
the response is a `200` **and** the body looks like the thing — `ref:` in `/.git/HEAD`, a
`KEY=value` line in `/.env`, the phrase "phpinfo" on `/phpinfo.php` — so a site that answers
every URL with its home page is not reported.

| Path | Looks like |
| --- | --- |
| `/.git/HEAD` | a git checkout |
| `/.git/config` | a git checkout |
| `/.env` | environment variables |
| `/.env.local`, `/.env.production` | environment variables |
| `/wp-config.php.bak` | a saved database password |
| `/phpinfo.php` | server internals |
| `/server-status` | Apache internals |
| `/.DS_Store` | a directory listing |
| `/backup.zip`, `/backup.sql`, `/db.sql` | a database dump |

## The rules

- **`robots.txt` is honoured.** A path disallowed for `*` or for our user agent is not
  requested, even though a stranger could. The site said no; we say so in the report.
- **Never authenticate.** No cookies, no headers beyond a browser's, no login forms.
- **Never send a payload.** `GET` only. Form checks inspect the form's action and, for
  an `http://` action, request that URL once with `GET` and no body to see whether it
  redirects; nothing is submitted.
- **Never enumerate.** One request per listed path, no wordlists, no parameter guessing,
  no user IDs. What a single public endpoint returns is what we see.
- **Same host only.** The probe never leaves the scan target's host.

Changing the list is a change to this file and to the code, reviewed together.
