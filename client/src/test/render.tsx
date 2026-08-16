import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

import { AuthProvider, type Auth, type AuthValue } from "@/lib/auth";
import { CLASSIC, type Intervals } from "@/lib/intervals";
import {
  SessionProvider,
  type Cycle,
  type Session,
  type SessionValue,
  type Today,
} from "@/lib/session";

/**
 * Render a piece of the app at a chosen route and a chosen auth state.
 *
 * Auth is injected rather than faked at `fetch` for the states that matter
 * here, because `loading` is the one that is hardest to hold still and the one
 * the layout-shift rules are actually about.
 *
 * The live session is left to `fetch` by default, so a test of the timer says
 * what the server answered rather than what the client happened to be holding.
 * A test of a component that only *reads* the session — the NavBar badge, the
 * alarm — may inject one with `session`, which is the same trade as auth: the
 * states worth pinning are the awkward ones.
 */
export function renderAt(
  ui: ReactNode,
  {
    path = "/",
    auth = { status: "anonymous" } as Auth,
    session,
  }: { path?: string; auth?: Auth; session?: SessionValue } = {},
) {
  const value: AuthValue = { ...auth, refresh: async () => {} };
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider value={value}>
        <SessionProvider value={session}>{ui}</SessionProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** Somebody signed in with a name — the only state the timer exists in. */
export const SIGNED_IN: Auth = { status: "authenticated", handle: "yazdan" };

/**
 * A session context holding exactly this session, with mutations that do
 * nothing — for the components that only read it.
 */
export function holding(
  session: Session | null | undefined,
  cycle: Cycle = { count: 0 },
  intervals: Intervals = CLASSIC,
  today: Today | undefined = { count: 0, totalMs: 0 },
): SessionValue {
  return {
    session,
    cycle,
    intervals,
    today,
    start: async () => null,
    cancel: async () => {},
    confirm: async () => null,
    save: async () => {},
    reload: async () => {},
  };
}

/** The fixture work session, twenty-five minutes ending `endsAt`. */
export function workSession(endsAt: number, over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    kind: "work",
    categoryId: "c1",
    categoryName: "درس",
    startedAt: endsAt - 25 * 60_000,
    endsAt,
    durationMs: 25 * 60_000,
    // The five minutes it owes, anchored at its own end — so a ring that
    // reaches this instant has spent the whole of it.
    breakEndsAt: endsAt + 5 * 60_000,
    resumeCategoryId: null,
    resumeDurationMs: null,
    ...over,
  };
}
