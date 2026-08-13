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
shell.

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

**Offline is out of scope.** v1 was local-first; this is not. Do not add local
queues, replay, or conflict resolution.

## Style

Go: standard library first (`net/http` with method patterns, `log/slog`),
`sqlc` + `pgx` for queries, `goose` migrations embedded and run at boot.
Domain logic goes in pure packages with the clock injected, so it is testable
without a database. Integration tests use a real Postgres, never a mock.

Copy is Persian and lives in `client/src/copy.json` — extremely casual
Gen-Z register, including error messages. Repo docs stay formal.
