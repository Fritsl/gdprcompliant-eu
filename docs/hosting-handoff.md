# Hosting handoff: put gdprhelper.eu on a server

A self-contained brief for whoever stands up production. Written 7 September 2026 against
commit `U-02: the product is GDPRhelper.eu`. Copy it into a fresh session as the prompt.

---

You are setting up production hosting for **GDPRhelper.eu**, a Next.js web app plus a
Node worker that drives headless Chromium, backed by one Postgres database with pgvector.
Source: `https://github.com/Fritsl/gdprcompliant-eu` (the repository keeps its old name;
the product is gdprhelper.eu). Read `README.md` and `HANDOFF.md` in the repo before you
start. The domain is registered at one.com and the DNS is managed there.

## The one rule that shapes every choice

The product's promise is that a European company's data never leaves Europe. Every
outbound host the code may call is declared in `packages/config/endpoints.json` with an
EEA jurisdiction, and the config refuses anything else at boot. Hosting must match:

- The server, the database, the object storage for backups and the model endpoint must
  be operated by a European-owned company from inside the EU/EEA. Not a US cloud in an
  EU region. Hetzner (Germany, owner-managed) is the default choice; Scaleway (France)
  and OVHcloud (France) are the alternatives.
- No analytics, no tracking, no consent banner on our own site. The site sets no
  cookies on the front door. Do not add anything that does.
- No CDN or DDoS proxy in front of the site unless it is European-owned (bunny.net,
  Gcore, Myra, Link11); most likely none is needed at launch.

## Target architecture

One VM is enough to start.

| Part | Choice |
| --- | --- |
| Server | Hetzner Cloud CPX31 or larger (4 vCPU, 8 GB; Chromium needs the memory), Ubuntu 24.04, location Falkenstein or Helsinki |
| Database | Postgres 16 with pgvector, in Docker on the same VM (`docker-compose.yml` in the repo, image `pgvector/pgvector:pg16`), data on a Hetzner Volume |
| Web | `pnpm web:build` then `pnpm web:start` on port 3000, as a systemd service |
| Worker | `pnpm worker:start`, as a systemd service, same `.env` |
| Reverse proxy and TLS | Caddy, HTTPS only, HTTP redirected. Certificates via ACME. Let's Encrypt is run by ISRG (US); if the customer-facing story must be European end to end, use Actalis (Italy, free DV over ACME) as Caddy's ACME CA |
| Backups | nightly `pg_dump` to Hetzner Object Storage (S3 API, Falkenstein), 30 days kept, restore tested once |
| Model endpoint | an OpenAI-compatible endpoint in the EU: Scaleway Generative APIs (Paris), OVHcloud AI Endpoints (Gravelines) or Mistral La Plateforme. Declared in `ENDPOINTS_EXTRA`. The app runs without one; scans and cases work, and the model-backed parts say the model was not measured |

## Steps

1. **Server.** Create the VM with an SSH key only, no password login. `ufw` allowing 22,
   80, 443. `unattended-upgrades` on. Create a user `gc` that owns the checkout; never run
   the app as root.
2. **Toolchain.** Node 22, pnpm 9.15.4 (`corepack enable && corepack prepare pnpm@9.15.4 --activate`),
   Docker Engine. Then in the checkout:
   ```bash
   pnpm install --frozen-lockfile
   pnpm exec playwright install --with-deps chromium
   ```
3. **Environment.** Copy `.env.example` to `.env`, mode 600, owned by `gc`. Set:
   - `NODE_ENV=production`
   - `APP_BASE_URL=https://gdprhelper.eu`
   - `DATABASE_URL=postgres://gc:<strong password>@127.0.0.1:5432/gdprcompliant`
     (change the password in `docker-compose.yml` too; the database name stays)
   - `GC_NETWORK=live`
   - `SCAN_CONCURRENCY=2`
   - `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_CHAT`, `MODEL_EMBEDDING` for the model
     endpoint, and `ENDPOINTS_EXTRA=[{"host":"<model host>","purpose":"model","jurisdiction":"FR"}]`
     with the real host and country. Leave the model variables at the example values if
     there is no endpoint yet.
   Every variable is validated at boot; a wrong one stops the process with a message
   naming it.
4. **Database.** `pnpm db:up` (waits until Postgres answers), then
   ```bash
   pnpm db:migrate
   pnpm db:seed
   ```
   `db:seed` loads the remedy catalogue and the law corpus. Without it every scan fails
   at the first finding. Add `--embedder=model` when a model endpoint is configured.
   Re-run both on every deploy; they are idempotent.
5. **Build and services.** `pnpm web:build`. Two systemd units, `gdprhelper-web` and
   `gdprhelper-worker`, `WorkingDirectory` at the checkout, `EnvironmentFile` the `.env`,
   `Restart=always`, running as `gc`. Web: `pnpm web:start`. Worker: `pnpm worker:start`.
   The worker logs one JSON line per event to stdout; journald keeps them.
6. **Caddy.** Sites: `gdprhelper.eu` and `www.gdprhelper.eu` reverse-proxied to
   `127.0.0.1:3000`; `gdprcompliant.eu` and `www.gdprcompliant.eu` permanently redirected
   to `https://gdprhelper.eu{uri}`. Add `Strict-Transport-Security` with a one-year
   max-age once the redirect is confirmed working.
7. **DNS at one.com.** In the one.com control panel, DNS settings for `gdprhelper.eu`:
   - `A` record, host `@`, the server's IPv4, TTL 3600
   - `AAAA` record, host `@`, the server's IPv6, TTL 3600
   - `A` and `AAAA` records, host `www`, the same addresses (one.com does not allow a
     CNAME at the apex, and a CNAME for `www` to `@` is fine if you prefer it)
   - Remove any one.com web-forwarding or parking entry for `@` and `www`; they would
     answer before the server does.
   - Leave MX, TXT and any mail-related records exactly as they are.
   Repeat the `A`/`AAAA` records for `gdprcompliant.eu` so the redirect works. Do not
   move nameservers away from one.com in this step; that is a separate decision.
   Propagation takes up to an hour at these TTLs.
8. **Two assumed hosts.** `packages/config/endpoints.json` declares
   `data.gdprhelper.eu` (an EU mirror of the Open Cookie Database, because its upstream
   is GitHub) and `ct.gdprhelper.eu` (an EU mirror of certificate-transparency search,
   because crt.sh is outside the EEA). Neither exists yet. Read the code paths that call
   them, confirm the scanner degrades cleanly when they do not answer, and report what a
   scan loses without them. Standing them up is a follow-up, not part of this brief.

## Verify before you report done

- `curl -sI https://gdprhelper.eu/en` returns 200 and no `Set-Cookie`.
- `curl -sI https://gdprcompliant.eu/` returns 301 to `https://gdprhelper.eu/`.
- On the site, enter a real address you control, run the test, and reach a case page
  with at least one finding and its fix. The worker journal shows `scan.job` with
  `"outcome":"ok"`.
- `systemctl status gdprhelper-web gdprhelper-worker` both active; both come back after
  `reboot`.
- A backup file exists in the bucket and `pg_restore --list` reads it.
- `pnpm run gate -- --dry-run` on the server prints the plan without a red line for
  anything the machine should be able to run.

## Report back with

The server's IPv4 and IPv6, the DNS records as set, the systemd unit files, the Caddyfile,
the backup schedule and bucket name, the case link from the verification scan, and the
answer on the two assumed hosts. Put secrets nowhere in the report.

## Do not

Do not use AWS, Azure, Google Cloud, Cloudflare or Vercel for any part, even in an EU
region. Do not add analytics, a status badge, a newsletter form or a contact form. Do not
change the code to make it deploy; if something in the repo blocks deployment, report it
with the exact error and stop.
