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

export type Kind = "work" | "shortBreak" | "longBreak";

export type Session = {
  id: string;
  kind: Kind;
  categoryId: string | null;
  categoryName: string | null;
  /** Absolute epoch milliseconds, always — never "seconds remaining". */
  startedAt: number;
  /** When the bell rings. Under fast sessions this is not startedAt + durationMs. */
  endsAt: number;
  /** The nominal length, which is what gets credited. */
  durationMs: number;
  /**
   * When the rest this pomodoro owes runs out. Null on a break, which owes
   * nothing.
   *
   * An instant rather than a length, because the break is anchored at the
   * nominal end: every second of ringing is a second of it already spent, so
   * this is fixed the moment the bell goes and the answer to "is there any
   * left?" is just the clock. It is the deadline, not a promise about how long
   * the break will run — as with `endsAt` and `durationMs`, fast sessions make
   * those two different things.
   */
  breakEndsAt: number | null;
  /**
   * What "another one" resumes, on a break: the task the pomodoro before it
   * was on, and the length it ran for. Null on a pomodoro.
   *
   * It comes from the server rather than from this device's remembered picks,
   * because the timer belongs to the person: a second device that opens into a
   * ringing break has never picked anything, and continuing there has to mean
   * the same task, not whatever that device last had selected.
   */
  resumeCategoryId: string | null;
  resumeDurationMs: number | null;
};

/**
 * How far into the cycle you are, and how long a cycle is.
 *
 * The server derives it from the sessions themselves on every read, so it
 * agrees across devices and cannot be lost.
 */
export type Cycle = { count: number; perCycle: number };

type SessionPayload = ServerTimed & { session: Session | null; cycle: Cycle };

/** Only ever shown once a payload has arrived; this is the shape, not a claim. */
const NO_CYCLE: Cycle = { count: 0, perCycle: 4 };

export type SessionValue = {
  /**
   * `null` means there is no timer; `undefined` means the answer has not
   * arrived yet, and the two are not the same thing to a screen that must not
   * flash a start button at somebody who is mid-pomodoro.
   */
  session: Session | null | undefined;
  cycle: Cycle;
  start: (categoryId: string, durationMs: number) => Promise<Session | null>;
  /** Abandon a pomodoro, or skip a break: the same fact, one endpoint. */
  cancel: (id: string) => Promise<void>;
  /** Acknowledge a bell, and receive whatever the timer became. */
  confirm: (id: string) => Promise<Session | null>;
  reload: () => Promise<void>;
};

/** Whether a session is one of the two kinds of rest. */
export function isBreak(session: Session): boolean {
  return session.kind !== "work";
}

/**
 * Whether confirming a ringing pomodoro right now still buys a break.
 *
 * The break was anchored at the nominal end before anybody was late, so this
 * is the ring racing a fixed instant — and the button's label follows it
 * second by second without asking the server again.
 */
export function breakSurvives(session: Session, now: number): boolean {
  return session.breakEndsAt !== null && now < session.breakEndsAt;
}

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
  const [cycle, setCycle] = useState<Cycle>(NO_CYCLE);

  // Every answer about the timer carries both, so they can never disagree:
  // the dots and the clock are two readings of one payload.
  const receive = useCallback((payload: SessionPayload) => {
    setSession(payload.session);
    setCycle(payload.cycle);
    return payload.session;
  }, []);

  const reload = useCallback(async () => {
    receive(await get<SessionPayload>("/api/session"));
  }, [receive]);

  // Nobody signed in has no timer to ask about, and asking would only be a
  // 401. Asking again when they sign in is what makes the answer arrive
  // without a reload.
  const signedIn = auth.status === "authenticated";
  useEffect(() => {
    if (disabled) return;
    if (!signedIn) {
      setSession(null);
      setCycle(NO_CYCLE);
      return;
    }
    void reload().catch(() => setSession(null));
  }, [disabled, signedIn, reload]);

  const start = useCallback(
    async (categoryId: string, durationMs: number) => {
      // Minted here, so a start retried on a poor connection lands on the
      // session it already began rather than beginning a second one.
      // Asking to start while one is live answers with the live one, so this
      // is also how a second device opens into a running timer.
      return receive(
        await post<SessionPayload>("/api/session/start", {
          id: crypto.randomUUID(),
          categoryId,
          durationMs,
        }),
      );
    },
    [receive],
  );

  // Abandoning a pomodoro and skipping a break are the same request: this
  // session is over and was not seen through.
  const cancel = useCallback(
    async (id: string) => {
      receive(await post<SessionPayload>(`/api/session/${id}/cancel`));
    },
    [receive],
  );

  // The one deliberate tap that ends a ring. A pomodoro's leaves the break it
  // earned running; a break's leaves an idle timer, because whether to go
  // round again is a question and not a default.
  const confirm = useCallback(
    async (id: string) => receive(await post<SessionPayload>(`/api/session/${id}/confirm`)),
    [receive],
  );

  return { session, cycle, start, cancel, confirm, reload };
}
