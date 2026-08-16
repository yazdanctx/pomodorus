import {
  createContext,
  use,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { get, post, type ServerTimed } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export type Session = {
  id: string;
  kind: "work" | "shortBreak" | "longBreak";
  categoryId: string | null;
  categoryName: string | null;
  /** Absolute epoch milliseconds, always — never "seconds remaining". */
  startedAt: number;
  /** When the bell rings. Under fast sessions this is not startedAt + durationMs. */
  endsAt: number;
  /** The nominal length, which is what gets credited. */
  durationMs: number;
};

type SessionPayload = ServerTimed & { session: Session | null };

export type SessionValue = {
  /**
   * `null` means there is no timer; `undefined` means the answer has not
   * arrived yet, and the two are not the same thing to a screen that must not
   * flash a start button at somebody who is mid-pomodoro.
   */
  session: Session | null | undefined;
  start: (categoryId: string, durationMs: number) => Promise<Session | null>;
  cancel: (id: string) => Promise<void>;
  confirm: (id: string) => Promise<void>;
  reload: () => Promise<void>;
};

/**
 * Whether a session's bell has gone.
 *
 * Derived, never stored and never pushed: before its end a session is running,
 * after its end and unacknowledged it is ringing. That is the whole of it —
 * which is why a tab that was asleep through the bell rings the moment it
 * wakes, and why nothing has to be scheduled for it to.
 */
export function isRinging(session: Session, now: number): boolean {
  return now >= session.endsAt;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * The live session, as the server has it.
 *
 * There is exactly one per person, and it is a row rather than anything
 * ticking — so this holds the facts and every screen derives the rest.
 *
 * It sits above the route because the bell does: a session that ends while
 * somebody is reading a profile, or the landing page, still has to reach them.
 */
export function useSession(): SessionValue {
  const value = use(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

export function SessionProvider({
  children,
  value,
}: {
  children: ReactNode;
  value?: SessionValue;
}) {
  const fetched = useFetchedSession(value !== undefined);
  return <SessionContext value={value ?? fetched}>{children}</SessionContext>;
}

function useFetchedSession(disabled: boolean): SessionValue {
  const auth = useAuth();
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  const reload = useCallback(async () => {
    const payload = await get<SessionPayload>("/api/session");
    setSession(payload.session);
  }, []);

  // Nobody signed in has no timer to ask about, and asking would only be a
  // 401. Asking again when they sign in is what makes the answer arrive
  // without a reload.
  const signedIn = auth.status === "authenticated";
  useEffect(() => {
    if (disabled) return;
    if (!signedIn) {
      setSession(null);
      return;
    }
    void reload().catch(() => setSession(null));
  }, [disabled, signedIn, reload]);

  const start = useCallback(
    async (categoryId: string, durationMs: number) => {
      // Minted here, so a start retried on a poor connection lands on the
      // session it already began rather than beginning a second one.
      const payload = await post<SessionPayload>("/api/session/start", {
        id: crypto.randomUUID(),
        categoryId,
        durationMs,
      });
      // Asking to start while one is live answers with the live one, so this
      // is also how a second device opens into a running timer.
      setSession(payload.session);
      return payload.session;
    },
    [],
  );

  const cancel = useCallback(async (id: string) => {
    const payload = await post<SessionPayload>(`/api/session/${id}/cancel`);
    setSession(payload.session);
  }, []);

  // The one deliberate tap that ends a ring. Nothing advances on its own, so
  // what comes back is an idle timer rather than the next session.
  const confirm = useCallback(async (id: string) => {
    const payload = await post<SessionPayload>(`/api/session/${id}/confirm`);
    setSession(payload.session);
  }, []);

  return { session, start, cancel, confirm, reload };
}
