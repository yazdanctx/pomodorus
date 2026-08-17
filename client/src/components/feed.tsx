import { Link } from "react-router";

import { copy } from "@/lib/copy";
import { isLive, useFeed, type FeedEntry } from "@/lib/feed";
import { enDigits, faClock } from "@/lib/format";
import { useTick } from "@/lib/server-clock";

/**
 * Who is working right now — the thing that makes the landing page feel
 * inhabited rather than like a product page.
 *
 * The box never vanishes. An empty feed holds a row's height and says so,
 * because a section that disappears is a page that reflows under whoever is
 * reading it the moment somebody, anywhere, starts a pomodoro.
 */
export function Feed() {
  const { entries } = useFeed();
  // Rows leave at their own bell, and the bell is derived rather than pushed —
  // so this ticks, and the list is filtered on every tick.
  const now = useTick();

  const live = entries?.filter((entry) => isLive(entry, now));

  return (
    <section className="w-full rounded-none border border-border bg-card">
      <ul className="divide-y divide-border">
        {live === undefined || live.length === 0 ? (
          // One row's height either way: a blank line while it is still being
          // asked for, and the sentence once the answer is in. Only a
          // server-confirmed empty feed says nobody is here.
          <li className="flex items-center justify-center px-4 py-3 text-sm text-muted-foreground">
            {live === undefined ? null : copy.feed.empty}
          </li>
        ) : (
          live.map((entry) => <Row key={entry.handle} entry={entry} now={now} />)
        )}
      </ul>
    </section>
  );
}

function Row({ entry, now }: { entry: FeedEntry; now: number }) {
  const resting = entry.kind !== "work";

  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
      <p className="min-w-0 truncate">
        {/* A handle is Latin by construction, so it is set out of the Persian
            face and pushed through enDigits — a Persian digit reaching one
            would read as a different name, and link to a different profile. */}
        <Link
          to={`/u/${entry.handle}`}
          className="truncate font-medium hover:underline [font-family:ui-sans-serif,system-ui,sans-serif]"
        >
          {enDigits(entry.handle)}
        </Link>
        <span className="text-muted-foreground">{" — "}</span>
        <span className="text-muted-foreground">{label(entry)}</span>
      </p>

      {/* A break shows no countdown: how long somebody's rest has left is not
          what this list is for, and it would read as work. */}
      {resting ? null : (
        <span
          dir="ltr"
          className="shrink-0 tabular-nums text-muted-foreground"
        >
          {faClock(entry.endsAt - now)}
        </span>
      )}
    </li>
  );
}

/** What this row says somebody is doing. */
function label(entry: FeedEntry): string {
  if (entry.kind !== "work") return copy.feed.onBreak;
  // A private task's name never left the server, so there is nothing to mask
  // here — the generic label is simply what this client has.
  return entry.task ?? copy.feed.privateTask;
}
