# 0007 — The device mirrors its own data and replays writes

**Status:** accepted (2026-11-04). Supersedes the offline half of ADR 0001;
the server remains the authority for the live slot.

## Context

ADR 0001 dropped offline in exchange for a timer that follows you between
devices. The users are on Iranian mobile networks, and the app being unusable
on a subway or during an outage turned out to cost more than the sync layer
it saved. v1's sync had three known faults: double-counted focus time across
devices, a pending queue nobody could inspect, and a service worker that
cached a stale app.

## Decision

The app is fully usable with no network, and the network is a replay target.

- **Mirror first, always.** Every write goes to the device's local *mirror* of
  the person's own data (sessions, tasks, intervals) and is then replayed to
  the server, online or not. There is one write path, exercised on every tap,
  so the offline path cannot rot unnoticed. Online, replay completes within
  the same tap and conflicts surface immediately.
- **Replay is the same idempotent POSTs** every mutation already makes, with
  the client-minted ids ADR 0001 kept as a hedge. Tasks replay before the
  sessions that use them. A blackhole and its inner pomodoros replay as one
  unit.
- **A finished session is always accepted, overlap included.** Losing recorded
  focus time is worse than a fat day. Only the live slot has a winner: whoever
  reached the server first. A device whose live session loses has it recorded
  as finished at the moment of reconnect, and shows the winner from then on.
- **Replay is bound to the account.** Pending work waits for a sign-in as the
  account that recorded it, and is dropped if another account signs in on that
  device.
- **Settings are last-write-wins** by the edit's own timestamp. Tasks and
  intervals have no history to lose.
- **Clocks.** Offline, the device stamps with its own clock corrected by the
  last skew it measured. The server clamps future-dated sessions to its own now
  on replay and second-guesses nothing else.
- **The service worker caches the app shell** so an installed app opens with no
  signal, in addition to receiving push. The mirror holds the whole of a
  person's own history, which is small. The feed and other people's profiles
  are the only things that need the network; the feed shows its last state with
  a "last seen" line, and the nav bar shows one small marker while offline or
  with unreplayed work.
- **Records are derived** from credited history, never stored, so a replay can
  set a best day dated last week and a discard can lower one. A stored record
  table would be a second ledger able to disagree with the first.

## Consequences

- Two devices used offline at once can both record finished sessions for the
  same hour. That is accepted; one-live-per-user still holds for whatever the
  server has seen.
- AGENTS.md's "offline is out of scope" and "the worker caches nothing" rules
  are withdrawn. "Do not build RPC over the socket" and "mutations are HTTP"
  stand: replay is HTTP.
