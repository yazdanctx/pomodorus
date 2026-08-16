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
import { CLASSIC, type Intervals } from "@/lib/intervals";
import { isTimerFrame, useSocket, type Frame } from "@/lib/socket";

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
 * How far into the cycle you are.
 *
 * The server derives it from the sessions themselves on every read, so it
 * agrees across devices and cannot be lost. How *long* a cycle is belongs to
 * the intervals: it is a setting, and one number held in two places is one
 * number that can be read wrong.
 */
export type Cycle = { count: number };

/**
 * How the Tehran day has gone so far: pomodoros credited since midnight there,
 * and what they were worth.
 *
 * `undefined` until the server has said, which is the whole of the rule that
 * only a server-confirmed total may call the day empty — a device that has not
 * asked yet, and a device belonging to nobody, both know nothing rather than
 * knowing zero.
 */
export type Today = { count: number; totalMs: number };

type SessionPayload = ServerTimed & {
  session: Session | null;
  cycle: Cycle;
  intervals: Intervals;
  today: Today;
};

/** Only ever shown once a payload has arrived; this is the shape, not a claim. */
const NO_CYCLE: Cycle = { count: 0 };

export type SessionValue = {
  /**
   * `null` means there is no timer; `undefined` means the answer has not
   * arrived yet, and the two are not the same thing to a screen that must not
   * flash a start button at somebody who is mid-pomodoro.
   */
  session: Session | null | undefined;
  cycle: Cycle;
  /**
   * What a break is worth on this account, and how long a cycle is. They ride
   * with the timer state because they are part of what the timer is — so a
   * device that has the session has, by the same payload, the settings it is
   * running under.
   */
  intervals: Intervals;
  /**
   * The day so far, or `undefined` while it is unknown. The start screen
   * reserves the row either way, so this being unknown costs no layout shift
   * and never renders as an empty day.
   */
  today: Today | undefined;
  start: (categoryId: string, durationMs: number) => Promise<Session | null>;
  /** Abandon a pomodoro, or skip a break: the same fact, one endpoint. */
  cancel: (id: string) => Promise<void>;
  /** Acknowledge a bell, and receive whatever the timer became. */
  confirm: (id: string) => Promise<Session | null>;
  /** Edit the account's intervals. All three, always — there is nothing to merge. */
  save: (intervals: Intervals) => Promise<void>;
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
  // The technique until the server says otherwise, which it does with the first
  // payload. A row of four dots that turns out to be three is a smaller lie
  // than an empty row that fills in.
  const [intervals, setIntervals] = useState<Intervals>(CLASSIC);
  // Deliberately not zero: a row that says "you did nothing today" before the
  // server has been asked is a row that is wrong for the length of a request,
  // and wrong in the most discouraging direction.
  const [today, setToday] = useState<Today | undefined>(undefined);

  // Every answer about the timer carries all of them, so they can never
  // disagree: the dots, the clock, the dialog and today's total are readings of
  // one payload.
  //
  // The payload's `serverNow` is folded into the clock anchor by the transport
  // and not here, because only a request can be timed: a response arrives with
  // a round trip to halve, and a pushed frame arrives with a one-way latency
  // that cannot be measured — treating it as instant would drag the anchor
  // backwards on every push.
  const receive = useCallback((payload: SessionPayload) => {
    setSession(payload.session);
    setCycle(payload.cycle);
    setIntervals(payload.intervals);
    setToday(payload.today);
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
      setIntervals(CLASSIC);
      // Back to unknown rather than to zero: nobody signed in has no day, and
      // saying they focused for nothing today would be a claim about somebody
      // the app has never met.
      setToday(undefined);
      return;
    }
    void reload().catch(() => setSession(null));
  }, [disabled, signedIn, reload]);

  // One timer, on every device at once.
  //
  // What arrives is the whole state rather than a nudge to go and ask, so a
  // pomodoro started on a phone is on the laptop in one hop — with the same
  // instants, and therefore the same digits.
  //
  // The socket is held open only while there is somebody to hold it for, and
  // the first frame after every connection is the current answer, so opening
  // the app and coming back from a tunnel are the same case.
  useSocket(
    !disabled && signedIn,
    useCallback(
      (frame: Frame) => {
        if (isTimerFrame(frame)) receive(frame.timer as SessionPayload);
      },
      [receive],
    ),
  );

  // A tab that has been in the background can have missed anything the person
  // did elsewhere: a timer started on their phone, or the intervals edited on
  // it. Kept alongside the socket rather than replaced by it, because a tab
  // that was asleep may have had its socket quietly dropped and not yet
  // noticed — and a failure here is left alone, because what is already on
  // screen is still the last thing the server said.
  useEffect(() => {
    if (disabled || !signedIn) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void reload().catch(() => {});
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
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

  // Sent whole and answered with the whole timer state, because this edit can
  // change what a session already on screen is heading for: a shorter cycle can
  // turn the rest the running pomodoro owes into the long one.
  const save = useCallback(
    async (next: Intervals) => {
      receive(await post<SessionPayload>("/api/intervals", next));
    },
    [receive],
  );

  return { session, cycle, intervals, today, start, cancel, confirm, save, reload };
}
