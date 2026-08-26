# Deploying on Liara

The deploy is one artifact: a Docker image holding a single Go binary that
serves the JSON API, the WebSocket and the built client. Around it sit two
managed Liara services — Postgres and an email server — and nothing else. See
`docs/adr/0005-one-binary-on-an-iranian-host.md` for why the host is Iranian
and what that costs.

Three files in the repo root do the work:

| | |
| --- | --- |
| `Dockerfile` | Builds the client, then the binary around it. Mirrors `make build`. |
| `.dockerignore` | Also the upload list — the Liara CLI reads it when it packs the project. |
| `liara.json` | App id, platform, port, timezone, build location, health check. |

## 0. The CLI

```bash
npm i -g @liara/cli
liara login
```

## 1. Create the app

Console → **برنامه‌ها** → create, with:

- **Platform:** Docker
- **App id:** `pomodorus` — whatever you pick must match `"app"` in
  `liara.json`, or `liara deploy` will ask every time.
- **Private network:** create one (`pomodorus`, say) and remember it. The
  database goes in the same network, and that is what lets the app reach it
  without exposing it publicly.

## 2. Create the database

Console → **دیتابیس‌ها** → PostgreSQL 17, **in the same private network**, with
public access off. Public access is only worth turning on temporarily, for the
`psql` check below and for backups.

Two things to settle before deploying anything:

**The connection string.** From the database's **نحوه اتصال** page, take the
*private* host — the database's id, port `5432` — and assemble:

```
postgres://root:PASSWORD@DB_ID:5432/postgres?sslmode=disable
```

`sslmode=disable` is right here and only here: the traffic never leaves
Liara's private network. If you ever point the app at the public host instead,
that becomes `sslmode=require`.

**The `citext` extension.** The first migration runs `CREATE EXTENSION IF NOT
EXISTS citext`, and a database that refuses it is a server that will not boot.
Liara documents PostGIS and pgvector, not citext, so verify it rather than
assume it — turn public access on for a minute and:

```bash
psql -h PUBLIC_HOST -p PUBLIC_PORT -U root -d postgres
# then, at the prompt:
CREATE EXTENSION IF NOT EXISTS citext;
```

If that errors, stop and open a ticket with Liara before going further; the
alternative is a schema change, not a deploy setting.

## 3. Create the email server

Login is an email OTP, so this is not optional, and it is the part most likely
to disappoint — a code that lands in spam is a login that does not work.

1. Console → **ایمیل سرور** → create one on your domain.
2. Add the DNS records it asks for (SPF, DKIM, DMARC) and wait for them to go
   green. Skipping DMARC is how mail to Gmail ends up in spam.
3. **افزودن نشانی** — add the sending address, e.g. `no-reply@yourdomain`.
4. **دسترسی SMTP** — add an SMTP user. You get a host like
   `smtp.c1.liara.email`, a username and a password.

**Use port 587, not 465.** The mailer is `net/smtp.SendMail`, which opens a
plain connection and upgrades it with STARTTLS. Port 465 is implicit TLS from
the first byte, and against it the client will hang and then fail. This is a
fact about the code, not a preference.

## 4. Mint the VAPID keypair

```bash
make vapid
```

Once, ever. The keypair is this deployment's permanent name to the push
services: replacing it silently invalidates every subscription any browser has
handed over, and no browser can be told. Keep the output somewhere you will
still have it in a year. Production refuses to boot without it.

## 5. Set the environment

Console → app → **تنظیمات** → **متغیرها**. `ENV`, `ADDR` and
`TRUST_PROXY_HEADERS` are already baked into the image as facts about the
deployment; everything below is a secret and belongs here instead:

```
DATABASE_URL=postgres://root:PASSWORD@DB_ID:5432/postgres?sslmode=disable
SMTP_HOST=smtp.c1.liara.email
SMTP_PORT=587
SMTP_USERNAME=...
SMTP_PASSWORD=...
SMTP_FROM=Pomodorus <no-reply@yourdomain>
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@yourdomain
```

`FAST_SESSIONS` is never set here. The server refuses to boot with it in
production, which is the point.

The `envs` field of `liara.json` is deliberately unused: it is committed, and
these are secrets.

## 6. Deploy

```bash
liara deploy
```

The build runs in Germany (`"build": {"location": "germany"}`), because the
Iranian build servers cannot reliably reach Docker Hub, the npm registry and
the Go module proxy. To build in Iran instead, set the location to `iran` and
point the image at Liara's mirrors — `https://package-mirror.liara.ir/repository/npm/`
for npm and `https://package-mirror.liara.ir/repository/go/` with `GOSUMDB=off`
for Go.

Liara builds the image on its own servers, so `docker build .` locally is a
check that the Dockerfile still works and nothing more — the architecture that
ships is theirs, not your laptop's.

The schema migrates itself at boot, from the binary's embedded migrations.
There is no migrate step, and no window in which a new binary talks to an old
schema.

## 7. Verify, in this order

```bash
curl https://pomodorus.liara.run/api/health
```

`{"ok":true,...,"database":"up"}` means the binary booted and the database
answered. Then, in a browser:

1. **Sign in with a real Gmail address, and with an Iranian one.** This is ADR
   0005's open risk and the only thing here that can send the project back to
   the drawing board. Check how long the code takes and which folder it lands
   in.
2. **Open the app in two browsers.** Start a session in one, watch the feed
   change in the other — that is the WebSocket through Liara's router.
3. **Install the app and allow notifications**, then let a session ring with
   the tab closed. That is the whole reason the VAPID keypair exists.

## 8. The domain

Console → app → **دامنه‌ها** → add yours, follow the DNS records, let Liara
issue the certificate. Then disable the default `*.liara.run` subdomain so the
app has one address. HTTPS is not optional for this app in any case: service
workers, push and the `Secure` session cookie all require it.

## What must not change

**One instance.** Socket fan-out is an in-process hub and the pending push
notifications are an in-memory timer. A second replica means each instance
knows only about its own connections: users would see half the feed, and the
bell would reach a closed tab only sometimes. Scale vertically. Horizontal
scaling needs Postgres `LISTEN/NOTIFY` behind the existing `Broadcaster`
interface first.

**Migrations stay backward compatible.** The health check holds traffic on the
old deployment until the new one answers, so for a moment the new binary's
migrations have already run while the old binary is still serving. A migration
that drops or renames something the old code reads breaks that moment.

**Open sockets die on deploy.** The client reconnects with backoff and the
first frames it receives are the whole current state, so this costs a second,
not correctness — session state is derived from rows and `now()`, never held
in the process.
