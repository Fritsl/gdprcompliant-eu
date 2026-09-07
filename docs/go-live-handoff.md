# Go-live handoff: take gdprhelper.eu from a repository to a public site

A self-contained brief for a coworker, human or agent, who has Frits's authority to act
on the accounts named here. Written 7 September 2026. Copy everything below the line into
a fresh session as the prompt.

---

You are taking **GDPRhelper.eu** live. The code is finished and on `main` at
`https://github.com/Fritsl/gdprcompliant-eu` (the repository name is old; the product is
gdprhelper.eu). What remains is accounts, a server, DNS and a verification scan. Work in
the order below, report after each numbered step, and stop at anything marked **stop**.

Two documents in the repository are the source of truth; read them first:

- `docs/hosting-handoff.md` — the server build, step by step, with the exact environment,
  the systemd units, the Caddy configuration and the verification list.
- `HANDOFF.md` and `README.md` — what the product is and what it must never do.

## Rules that do not bend

- Only European-owned providers, operated from inside the EU/EEA. Not a US cloud in an
  EU region. Hetzner (Germany) is the default; Scaleway or OVHcloud (France) are the
  alternatives. This is the product's whole promise, not a preference.
- Never paste a password, API key or token into a chat, a ticket or this report. Keys go
  into the server's `.env` file (mode 600) or a password manager, nothing else.
- Do not change the application code. If something in the repository blocks deployment,
  report the exact error and **stop**.
- Do not add analytics, a status badge, a newsletter form, a contact form or a cookie
  banner to the site.

## Step 1. The server

Create a Hetzner Cloud project named `gdprhelper` and one server:

| Setting | Value |
| --- | --- |
| Image | Ubuntu 24.04 |
| Type | CPX31 (4 vCPU, 8 GB); Chromium needs the memory |
| Location | Falkenstein (fsn1) or Helsinki (hel1) |
| Networking | IPv4 and IPv6 both enabled |
| SSH keys | your own key, plus the deploy key below so Frits's machine can reach it |
| Backups | enable Hetzner's server backups (they are in the same location) |

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH5wXn0VmbqwNS6S0zBHgT550vL2934VMhNBniA7ATMT gdprhelper-deploy
```

Also create a Hetzner Object Storage bucket in Falkenstein named `gdprhelper-backups`
for the nightly database dumps. Report the server's IPv4 and IPv6.

## Step 2. Build the server

Follow `docs/hosting-handoff.md` steps 1 to 6 exactly: hardening, toolchain, `.env`,
database with `pnpm db:migrate` then `pnpm db:seed`, `pnpm web:build`, the two systemd
services, Caddy with HTTPS. Use the server's IP in `APP_BASE_URL` only until DNS is
live, then switch it to `https://gdprhelper.eu` and restart both services.

Leave the four `MODEL_*` variables at the values from `.env.example` unless step 5 has
already produced a key. The site runs without a model.

Report: `systemctl status` of both services, and that `curl -sI http://<ipv4>:3000/en`
on the server returns 200.

## Step 3. DNS at one.com

Log in to the one.com control panel as Frits, open DNS settings for `gdprhelper.eu`, and
set exactly these records, TTL 3600:

| Type | Host | Value |
| --- | --- | --- |
| A | @ | the server's IPv4 |
| AAAA | @ | the server's IPv6 |
| A | www | the server's IPv4 |
| AAAA | www | the server's IPv6 |

Remove any web-forwarding, parking or "one.com website" entry for `@` and `www`; they
answer before the server does. Do not touch MX, TXT or anything mail-related. Do not
change the nameservers. Repeat the same four records for `gdprcompliant.eu`, which Caddy
redirects to the new name. Propagation takes up to an hour.

Report the records as set, in the table form above.

## Step 4. Verify

From a machine outside the server, once DNS answers:

- `curl -sI https://gdprhelper.eu/en` returns 200 with no `Set-Cookie` header.
- `curl -sI https://gdprcompliant.eu/` returns 301 to `https://gdprhelper.eu/`.
- Open https://gdprhelper.eu in a browser, enter a real website you control, press
  "Run the test", and reach a case page with at least one finding and its fix. The worker
  journal (`journalctl -u gdprhelper-worker`) shows `scan.job` with `"outcome":"ok"`.
- `sudo reboot`; both services are active again within two minutes and the site answers.
- The first nightly backup exists in the bucket, and `pg_restore --list` reads it.

Report each line with pass or fail and the case link from the scan. A fail on any line is
a **stop**, with the exact output.

## Step 5. Optional, after the site is live

- **Model endpoint.** Create an account at Scaleway (console.scaleway.com, Generative
  APIs, Paris) or Mistral (console.mistral.ai). Generate one API key, put it in the
  server's `.env` as `MODEL_API_KEY` with `MODEL_BASE_URL`, `MODEL_CHAT` and
  `MODEL_EMBEDDING` for that provider, add the host to `ENDPOINTS_EXTRA` as described in
  `docs/hosting-handoff.md`, run `pnpm db:seed --embedder=model`, restart both services.
  Report which provider and model, never the key.
- **Repository rename.** On GitHub, rename `Fritsl/gdprcompliant-eu` to
  `Fritsl/gdprhelper-eu` (Settings, General, Repository name). GitHub redirects the old
  name. Then on the server: `git remote set-url origin https://github.com/Fritsl/gdprhelper-eu.git`.

## Known gap, not yours to fix

The application writes colleague invitations and reminders to an outbox table; nothing
sends them yet. Invitation links still work when the case owner shares them by hand.
Sending mail needs a European relay and a small sender; that is a follow-up task for the
code, not for this brief. Do not wire up a mail service on your own.

## What "done" looks like

A report with: the server's addresses, the DNS table as set for both domains, both
service statuses, the Caddyfile, the backup bucket and schedule, the five verification
lines each marked pass, and the case link from the first real scan. No secrets anywhere
in it.
