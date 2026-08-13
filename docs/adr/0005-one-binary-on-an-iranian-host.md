# 0005 — One binary, on an Iranian host

**Status:** accepted (2026-08-13). Contains the project's largest open risk.

## Deployment shape

The Go binary serves the JSON API, the WebSocket, **and** the built React
client, embedded via `embed.FS`. One artifact: no CDN, no nginx, no chance of
the HTML and the API being different versions of the app — which is exactly how
v1 broke in production, twice, by deploying the frontend ahead of its backend.

Public routes (`/` and `/u/{handle}`) get OG/Twitter meta injected into the
HTML shell before it is served, so shared links preview in Telegram and Twitter
without any server-side rendering. Content still renders client-side.

In development Vite serves the client and proxies `/api` and `/ws` to Go, so
the browser stays on one origin and the session cookie behaves exactly as it
will in production.

## Transport

- **Mutations are HTTP.** Ordinary POSTs, real status codes, idempotent via a
  client-minted id, debuggable with curl.
- **The socket only pushes facts.** Feed changed, your timer changed on another
  device, today's focus changed. It never carries request/response correlation,
  timeouts or error semantics, because HTTP already has those.
- Fan-out is an in-process hub behind a `Broadcaster` interface. A single
  instance needs nothing more; Postgres `LISTEN/NOTIFY` is the drop-in swap if
  that ever stops being true. 30-second ping/pong keepalive, because the
  hosting proxy will drop idle sockets.

## Sessions

An opaque 32-byte token in an httpOnly, Secure, SameSite=Lax cookie, backed by
a row in Postgres with a sliding 90-day expiry. Revocable instantly, invisible
to JavaScript, and attached to the WebSocket upgrade by the browser without a
token-in-query-string hack. A JWT would have traded a sub-millisecond indexed
read for a refresh-token dance and no way to revoke.

## Hosting, and the risk

Deployed on an **Iranian host (Liara)**, with managed Postgres. This is the
decision that makes the app usable: the users are in Iran, and a foreign VPS is
reachable only over a VPN — when it is reachable at all, since many foreign
hosts block Iranian IPs outright.

It also creates the project's biggest unknown. **Foreign SMTP providers —
Resend, SendGrid, Mailgun, Postmark — refuse Iranian accounts and IPs under
sanctions**, and mail sent from an Iranian IP directly to Gmail is likely to be
spam-foldered or rejected. Login is email OTP (ADR 0003), so a code that lands
in spam ten minutes late is a login that does not work.

Mitigation: use Liara's own managed email service, which exists precisely
because foreign relays are unavailable, and keep it behind a `Mailer`
interface — Mailpit locally, Liara in production, and a second channel
swappable as one implementation.

**This must be tested with a real send to Gmail and to at least one Iranian
provider before anything is built on top of it.** If it fails, the fallback is
SMS OTP through an Iranian provider (Kavenegar, SMS.ir), which changes the
identity model in ADR 0003 from an address to a phone number.
