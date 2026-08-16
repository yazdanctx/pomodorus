import { useCallback, useEffect, useState } from "react";

import { get, post, type ServerTimed } from "@/lib/api";

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

/**
 * The live session, as the server has it.
 *
 * There is exactly one per person, and it is a row rather than anything
 * ticking — so this holds the facts and the screen derives the rest. `null`
 * means there is no timer; `undefined` means the answer has not arrived yet,
 * and the two are not the same thing to a screen that must not flash a start
 * button at somebody who is mid-pomodoro.
 */
export function useLiveSession() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  const reload = useCallback(async () => {
    const payload = await get<SessionPayload>("/api/session");
    setSession(payload.session);
  }, []);

  useEffect(() => {
    void reload().catch(() => setSession(null));
  }, [reload]);

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

  return { session, start, cancel, reload };
}
