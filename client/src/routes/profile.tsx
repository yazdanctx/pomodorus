import { LogOut } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { DayDetail } from "@/components/profile/day-detail";
import { Failure } from "@/components/failure";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { copy, t } from "@/lib/copy";
import { enDigits, faDigits } from "@/lib/format";
import {
  DEFAULT_RANGE,
  RANGES,
  selectDay,
  useProfile,
  type ChartDay,
  type Range,
} from "@/lib/profile";

/**
 * Loaded only when somebody opens a profile.
 *
 * The charting library is around half the weight of everything else in the app
 * put together, and this is the one screen that uses it — the landing page and
 * the timer must not pay for it. The fallback is the same skeleton the chart
 * area already shows while its data is in flight, so the split is invisible:
 * there is one placeholder, not two in sequence.
 */
const FocusChart = lazy(async () => ({
  default: (await import("@/components/profile/focus-chart")).FocusChart,
}));

/**
 * Somebody's public page: their name, and how much they have focused per day.
 *
 * Read-only and reachable by anyone — the whole reason a handle is permanent is
 * that it makes a link worth sending. Nothing here says *what* was worked on;
 * that is the day detail's business, and it is where the private/public
 * distinction lives.
 */
export function ProfileRoute() {
  const { handle = "" } = useParams();
  const auth = useAuth();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const { handle: canonical, days, everFocused, owner, missing, failed } = useProfile(handle, range);
  // The day being pointed at — a gesture rather than a fact about the profile,
  // so it is held here and not in the payload. A day pointed at in one range
  // and still present in the next stays selected; one that falls outside gives
  // way to the most recent day with anything in it, which is what the page
  // opens on.
  const [pointed, setPointed] = useState<string | null>(null);
  const selected = days === undefined ? null : selectDay(days, pointed);

  // Whose page this is. Compared against the canonical handle when there is
  // one, so a link typed in the wrong case still recognises its owner.
  const mine =
    auth.status === "authenticated" &&
    auth.handle !== null &&
    auth.handle.toLowerCase() === (canonical ?? handle).toLowerCase();

  if (missing) return <NotFound />;

  return (
    <main className="flex flex-1 flex-col gap-6 p-6">
      <Header handle={canonical ?? handle} mine={mine} />

      <section>
        {/* The shell — the heading and the presets — never moves. Only the
            chart below falls back while a new range is being fetched, so
            switching from seven days to ninety does not reflow the page under
            the finger that pressed it. */}
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-medium">{copy.profile.focusPerDay}</h2>
          <Ranges value={range} onChange={setRange} />
        </div>

        <div className="mt-4">
          {failed ? (
            <Failure message={copy.login.serverError} />
          ) : days === undefined ? (
            <ChartSkeleton />
          ) : !everFocused ? (
            // Never focused at all, which is not the same as a range that
            // happens to be empty: a week off is a flat line, and the zero-fill
            // exists to draw it.
            <Empty />
          ) : (
            <Suspense fallback={<ChartSkeleton />}>
              <FocusChart
                days={days}
                selected={selected?.day ?? null}
                onSelect={setPointed}
              />
              <DayPanel
                day={selected?.detail}
                handle={canonical ?? handle}
                owner={owner}
              />
            </Suspense>
          )}
        </div>
      </section>
    </main>
  );
}

/**
 * The docked day detail, and the fade between one day and the next.
 *
 * The outgoing panel finishes leaving before the incoming one arrives, rather
 * than the two dissolving through each other: they differ in height with the
 * length of the task list, and running them together would shunt the page
 * around under whoever is reading it.
 *
 * A day with nothing in it has no panel at all — not a panel that says ۰:۰۰
 * over an empty list — so the fade is also how the panel goes away.
 */
function DayPanel({
  day,
  handle,
  owner,
}: {
  day: ChartDay | undefined;
  handle: string;
  owner: boolean;
}) {
  const [shown, setShown] = useState(day);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (day?.day === shown?.day) {
      // The same day, but possibly a fresher copy of it — a range switch
      // re-fetches the days it already had.
      if (day !== shown) setShown(day);
      return;
    }
    setLeaving(true);
    const handover = setTimeout(() => {
      setShown(day);
      setLeaving(false);
    }, FADE_MS);
    return () => clearTimeout(handover);
  }, [day, shown]);

  if (shown === undefined) return null;

  return (
    // Keyed by the day, so each one is its own arrival: the outgoing panel
    // fades out on this element, and the incoming one is a fresh element that
    // fades in.
    <div
      key={shown.day}
      className={`duration-300 ease-out ${
        leaving ? "opacity-0 transition-opacity" : "animate-in fade-in-0"
      }`}
    >
      <DayDetail day={shown} handle={handle} owner={owner} />
    </div>
  );
}

/** Matches the `duration-300` the panel fades over. */
const FADE_MS = 300;

/** The chart area's exact box, held while either its code or its data arrives. */
function ChartSkeleton() {
  return <Skeleton className="h-44 w-full" />;
}

/**
 * On your own profile this is a heading and the way out; on somebody else's it
 * is their name.
 *
 * A handle is Latin by construction, so it is set out of the Persian face and
 * pushed through `enDigits` — a Persian digit reaching one would read as a
 * different name, and link to a different person.
 */
function Header({ handle, mine }: { handle: string; mine: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      {mine ? (
        <h1 className="text-base font-medium">{copy.profile.title}</h1>
      ) : (
        <h1 className="truncate text-base font-medium [font-family:ui-sans-serif,system-ui,sans-serif]">
          {enDigits(handle)}
        </h1>
      )}
      {mine ? <SignOut /> : null}
    </div>
  );
}

function SignOut() {
  const auth = useAuth();
  const navigate = useNavigate();

  async function signOut() {
    await post("/api/auth/sign-out");
    await auth.refresh();
    // Away from a page that is about to stop being yours: the profile still
    // reads, but the button that was just pressed would vanish under the
    // cursor and the heading would change to a name.
    void navigate("/");
  }

  return (
    <Button variant="outline" onClick={() => void signOut()}>
      <LogOut />
      {copy.header.signOut}
    </Button>
  );
}

/**
 * The three presets, and no custom picker.
 *
 * The selected one is filled and the others are quiet, which is the only
 * signal — there is no hue available to mark a selection with.
 */
function Ranges({
  value,
  onChange,
}: {
  value: Range;
  onChange: (range: Range) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {RANGES.map((days) => (
        <Button
          key={days}
          size="xs"
          variant={days === value ? "secondary" : "ghost"}
          aria-pressed={days === value}
          onClick={() => onChange(days)}
        >
          {t(copy.profile.rangeDays, { n: faDigits(days) })}
        </Button>
      ))}
    </div>
  );
}

/** Somebody real who has not finished a pomodoro yet. */
function Empty() {
  return (
    <div className="mt-6 flex flex-col items-center gap-6 border p-12 text-center sm:p-20">
      <p className="text-sm text-muted-foreground">{copy.profile.emptyTitle}</p>
    </div>
  );
}

/** A handle nobody has — a mistyped link, or one whose owner never existed. */
function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <p className="text-sm text-muted-foreground">{copy.profile.notFound}</p>
    </main>
  );
}
