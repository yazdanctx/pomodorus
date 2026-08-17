# Pomodorus

A minimal Persian-language pomodoro app with a live global feed and public
focus-time profiles.

React + Go + Postgres + WebSockets. The design is carried over unchanged from
the original Next.js version; everything behind it was rewritten.

## Requirements

Go 1.24+, Node 22+, Docker.

## Getting started

```bash
make up     # Postgres on :5433, Mailpit on :1025 (inbox: localhost:8025)
make dev    # Go API on :8081, Vite client on :5174
```

Open http://localhost:5174.

There is no SMTP server to configure. Mailpit is a fake one with a web inbox,
so login codes are readable at http://localhost:8025 — and the server uses the
same SMTP code path locally that it uses in production, rather than a dev-only
branch.

The schema migrates itself on boot, so there is no migrate step to forget.

## Web Push

The bell reaches a closed tab through Web Push, which needs a VAPID keypair.
Locally there is none and push is simply off — everything else works, and the
ring still arrives in any open tab. To try it, generate a pair and put it in
the server's environment:

```bash
make vapid   # prints VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
```

The keypair is permanent: replacing it silently invalidates every subscription
any browser has ever handed over. Production refuses to boot without one.

## Building

```bash
make build   # client → server/internal/web/dist → embedded in bin/pomodorus
./bin/pomodorus
```

One binary serves the API, the WebSocket and the client.

## Testing

```bash
make test          # everything
make test-server   # Go (integration tests need `make up`)
make test-client   # Vitest
```

## Layout

| | |
| --- | --- |
| `client/` | Vite + React + TypeScript + Tailwind v4 |
| `server/` | Go: API, WebSocket hub, embedded client |
| `docs/design-tokens.md` | The design, as exact values |
| `docs/reference/` | Screenshots of v1 — the pixel target |
| `docs/adr/` | Architecture decisions and why |

## The previous version

Everything up to the `v1-nextjs` tag was Next.js + Convex, with a local-first
offline timer. It is not the basis for anything here beyond the design:

```bash
git show v1-nextjs:components/timer-app.tsx
```
