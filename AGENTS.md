# Pomodorus

A minimal Persian-language pomodoro app: a timer, a live global feed of who is
working right now, and public profiles with a focus-time chart.

React client, Go backend, Postgres, WebSockets. **This is a ground-up rewrite**
— everything before the `v1-nextjs` tag was Next.js + Convex and is gone. Do
not follow patterns from that tree; it survives only as the design reference.

## Layout

| | |
| --- | --- |
| `client/` | Vite + React + TypeScript + Tailwind v4 SPA |
| `server/` | Go: JSON API, WebSocket hub, and the embedded client |
| `docs/design-tokens.md` | The exact design values. Read before writing UI. |
| `docs/reference/` | Screenshots of v1 — the pixel target. |
| `docs/adr/` | Why the architecture is the way it is. |
| `docs/deploy-liara.md` | How it is deployed on Liara, and what must not change. |
| `deploy/` | The compose stack, Caddyfile and backup script for a self-hosted deploy. |
| `docs/agents/` | How the engineering skills read this repo. |

## Agent skills

### Issue tracker

Issues live as GitHub issues on `yazdanctx/pomodorus`, via the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root plus `docs/adr/`. See
`docs/agents/domain.md`.

## Running it

`make up` starts Postgres (**:5433**) and Mailpit (**:1025** SMTP, inbox at
**http://localhost:8025**). `make dev` runs the Go API (**:8081**) and Vite
(**:5174**) together. The ports avoid the obvious ones because this machine
already runs a native Postgres on 5432 and something else on 8080 and 5173.

`make build` builds the client into the binary. `make psql` opens a database
shell. `make vapid` prints the keypair Web Push needs — without one in the
environment push is off, which is the normal state locally and a refused boot
in production.

## Rules that are not obvious

**The design is fixed.** The UI matches v1 pixel for pixel. Values come from
`docs/design-tokens.md`, not from taste. In particular: `--radius: 0rem`
everywhere, no shadows, monochrome — errors are white/boxed/iconned rather than
red, and the *only* hue in the entire app is `rose-500` on a ringing timer
(plus `yellow-600`, which belongs to the wordmark alone).

**The server owns the timer.** A session is a stored fact — `started_at`,
`duration_ms`, `confirmed_at` — never a ticking clock. State is *derived* from
those columns plus `now()`: before `ends_at` it is running, after it and
unconfirmed it is ringing. There is no scheduler, no cron, and no job that
flips rows. Do not add one. The only exception is a best-effort in-memory timer
whose sole job is firing a Web Push notification; it owns no state, and losing
it costs a notification, never correctness.

**Clocks.** Every timestamp crossing the wire is absolute epoch milliseconds,
never "seconds remaining". Every response carries the server's `now` so the
client can correct for skew: the device clock is trusted to measure elapsed
time and never to say what time it is.

**Mutations are HTTP, pushes are WebSocket.** Every write is an ordinary
idempotent POST carrying a client-minted id. The socket only pushes facts. Do
not build RPC over the socket.

**One live session per user**, enforced by a partial unique index. Starting
when one is already live returns the existing session rather than erroring.

**Nothing advances on its own.** A session that reaches its end rings until an
explicit tap. Work is credited at its exact nominal end regardless of when it
is confirmed, and the break is anchored at that end — so ring time is eaten out
of the break, and a long enough ring leaves none.

**`FAST_SESSIONS` is server-side only.** A client that could request a fast
session could mint focus time from nothing. It is refused outright in
production.

**Forwarded headers are read from the right.** `X-Forwarded-For` and
`X-Forwarded-Proto` are believed only `TRUSTED_PROXY_HOPS` back from the *last*
value, never the first. Each proxy appends what it saw, so the left end is
whatever the caller invented — reading it hands the rate limiter a bucket the
attacker chose. One hop is a reverse proxy; two is a CDN in front of it.

**The tight limit is per account, the loose one is per address.** Iranian
mobile networks put thousands of people behind one CGNAT address, so a per-IP
limit tight enough to matter breaks the app for a whole network. Writes are
limited per user — which is also where the cost is, since a write fans out to
every socket — and the per-address limit is a deliberately loose backstop for
the two public reads. Do not tighten the second one to fix a problem that
belongs to the first. The socket ceiling is global for the same reason.

**The push endpoint is a URL a client chose.** The server later posts to it, so
it is checked at dial time against the resolved address, not at subscribe time
against the string — that gap is DNS rebinding. Subscriptions are also capped
per account, by trimming the least recently seen: without a ceiling one account
turns each bell into unbounded outbound requests at a target of its choosing.

**Offline is a mirror plus a replay, not a second mode.** Every write goes to
the device's local mirror first and is replayed to the server through the same
idempotent POSTs, online or not. The server still owns the live slot: one live
session per user, first to reach the server wins, and a finished session
replayed late is always accepted. The service worker caches the app shell and
receives push; it does nothing else. See ADR 0007, which supersedes the
offline half of ADR 0001.

**A blackhole is a session, not a mode.** Open-ended, credited for elapsed
time up to a 16 hour cap, holding several tasks, and the one live session its
inner pomodoros hang off. See ADR 0006 and `CONTEXT.md`.

## Style

Go: standard library first (`net/http` with method patterns, `log/slog`),
`sqlc` + `pgx` for queries, `goose` migrations embedded and run at boot.
Domain logic goes in pure packages with the clock injected, so it is testable
without a database. Integration tests use a real Postgres, never a mock.

Copy is Persian and lives in `client/src/copy.json` — extremely casual
Gen-Z register, including error messages. Repo docs stay formal.

The one exception is the link-preview text in `server/internal/web/meta.go`:
it is markup for crawlers rather than words on a screen, no reader of the app
ever sees it, and the alternative is the server reading the client's bundle at
request time. Nothing else in Go carries Persian — an API error is a code, and
the sentence for it lives in `copy.json`.
