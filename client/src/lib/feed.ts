/**
 * Who is working right now.
 *
 * The one public read in the app: it needs no account, and most of the people
 * who see it have never had one. It is a query over live sessions rather than a
 * roster something maintains, so it cannot go stale and cannot disagree with
 * the timers it describes.
 */

import { useCallback, useEffect, useState } from "react";

import { get, type ServerTimed } from "@/lib/api";
import { isFeedFrame, useSocket, type Frame } from "@/lib/socket";

export type FeedEntry = {
  /** Latin by construction, and rendered as such. */
  handle: string;
  kind: "work" | "shortBreak" | "longBreak";
  /**
   * The task, or `null` — which is a break, or a private task whose name never
   * left the server. Which of those it is, is the `kind`'s to say.
   */
  task: string | null;
  /** When this session's bell goes. Absolute, like every instant here. */
  endsAt: number;
};

type FeedPayload = ServerTimed & { entries: FeedEntry[] };

/**
 * Whether a row is still somebody working.
 *
 * Decided here, against the skew-corrected clock, rather than waited for: the
 * server drops a row at its nominal end, but nothing is pushed *at* that
 * instant — there is no scheduler, and a bell is derived from a stored fact
 * plus now. Every row carries its own end, so a page that has been open for an
 * hour empties itself exactly on time without asking anybody.
 */
export function isLive(entry: FeedEntry, now: number): boolean {
  return now < entry.endsAt;
}

export type FeedValue = {
  /**
   * `undefined` until the server has answered. A visitor should not be told
   * "nobody is working" by a page that has not asked yet.
   */
  entries: FeedEntry[] | undefined;
};

export function useFeed(): FeedValue {
  const [entries, setEntries] = useState<FeedEntry[] | undefined>(undefined);

  const load = useCallback(async () => {
    const payload = await get<FeedPayload>("/api/feed");
    setEntries(payload.entries);
  }, []);

  // Asked once on arrival. The socket's first frame answers the same question,
  // so this is mostly redundant — and it is kept because it is the path that
  // works when the socket does not: a proxy that eats upgrades leaves a feed
  // that is correct on load and merely stops moving.
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  // And then it is pushed. A visitor is subscribed to the feed's topic and to
  // nothing else, so this is the only kind of frame they can receive.
  useSocket(
    true,
    useCallback((frame: Frame) => {
      if (isFeedFrame(frame)) setEntries((frame.feed as FeedPayload).entries);
    }, []),
  );

  return { entries };
}
