import { LogOut } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { Failure } from "@/components/failure";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { copy, t } from "@/lib/copy";
import { enDigits, faDigits } from "@/lib/format";
import { DEFAULT_RANGE, RANGES, useProfile, type Range } from "@/lib/profile";

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
  const { handle: canonical, days, everFocused, missing, failed } = useProfile(handle, range);

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
              <FocusChart days={days} />
            </Suspense>
          )}
        </div>
      </section>
    </main>
  );
}

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
