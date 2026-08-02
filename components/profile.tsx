"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogOut } from "lucide-react";
import Image from "next/image";
import { api } from "@/convex/_generated/api";
import { DayCard, useBanner } from "@/components/day-card";
import { FocusChart } from "@/components/focus-chart";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { copy, t } from "@/lib/copy";
import { focusHistory, type ChartPayload } from "@/lib/focus-history";
import { faDigits } from "@/lib/format";

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

// Placeholder for the chart + day-detail area, shown while a range loads.
function ChartAreaSkeleton() {
  return (
    <div>
      <Skeleton className="mt-4 h-44 w-full" />
      <div className="mt-10">
        <div className="flex items-stretch gap-4">
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-12 w-28" />
            <Skeleton className="h-6 w-32" />
          </div>
          <Skeleton className="aspect-square w-1/2 shrink-0" />
        </div>
        <div className="mt-4 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <div className="flex items-baseline justify-between gap-3">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-16" />
              </div>
              <Skeleton className="mt-1.5 h-1 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * A range with no focus time in it. Given a picture and room to breathe rather
 * than a line of grey text, so a quiet week reads as a page in its own right —
 * which for a new account is the first thing the profile ever shows.
 *
 * Keyed on the profile alone, so switching Range doesn't reshuffle the art the
 * way it would if the range were part of the key.
 */
function EmptyRange({
  username,
  banners,
}: {
  username: string;
  banners: string[];
}) {
  const src = useBanner(banners, `${username}:empty`);

  return (
    <div className="mt-6 flex flex-col items-center gap-6 border p-12 text-center sm:p-20">
      {/* The same fade the day card puts over its image: the picture rises out
          of the page instead of sitting in a box on it. */}
      <div className="relative aspect-square w-36 shrink-0 overflow-hidden sm:w-44">
        <div className="absolute inset-0 z-10 bg-linear-to-t from-background via-background/20 to-transparent" />
        {src !== null && (
          <Image
            src={src}
            alt=""
            fill
            sizes="11rem"
            // Hand-optimised AVIF already; see the day card.
            unoptimized
            className="object-cover"
          />
        )}
      </div>
      <p className="text-base font-bold sm:text-lg">
        {copy.profile.emptyTitle}
      </p>
    </div>
  );
}

// Signing out lives here because the profile is the only page a signed-in
// visitor has of their own; the nav bar is shared with signed-out visitors.
function SignOutButton() {
  const { signOut } = useAuthActions();
  const router = useRouter();

  return (
    <Button
      size="sm"
      variant="outline"
      className="text-muted-foreground"
      onClick={async () => {
        // A failed sign-out still means leaving: the session it could not
        // clear is the server's problem, not something to strand the
        // visitor on their own profile over.
        await signOut().catch(() => {});
        router.push("/");
      }}
    >
      <LogOut />
      {copy.header.signOut}
    </Button>
  );
}

export function Profile({
  username,
  banners,
}: {
  username: string;
  banners: string[];
}) {
  const [range, setRange] = useState<Range>(7);
  const [hovered, setHovered] = useState<string | null>(null);
  const live = useQuery(api.profiles.chart, { username, days: range });

  // Switching ranges resubscribes the query, which momentarily returns
  // undefined. Keeping the last payload is what lets the page shell stay
  // mounted while only the chart area falls back to a skeleton — the focus
  // history module decides which of those two is happening.
  const [cached, setCached] = useState<ChartPayload | undefined>(undefined);
  if (live !== undefined && live !== cached) setCached(live);
  const view = focusHistory({ live, cached, hovered });

  // Someone else's profile is a public page — only its owner gets the button.
  const isOwner =
    view.state !== "loading" && view.state !== "notFound" && view.isOwner;

  return (
    <main className="flex flex-1 flex-col p-6">
      {/* The page's one heading, and the one control that isn't about the
          chart, at opposite ends of a single row. Held at the button's own
          height in every state — including the states with no button — so
          the row does not grow under the page when auth resolves. */}
      <div className="flex h-8 items-center justify-between gap-3">
        <h1 className="text-base font-medium">{copy.profile.title}</h1>
        {isOwner && <SignOutButton />}
      </div>

      {/* Every state below opens on one `mt-8`. The gap used to be that plus a
          page-top padding of its own — two spacings for one edge, from back
          when nothing sat above them. */}
      {view.state === "loading" ? (
        <div className="mt-8">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-7 w-40" />
          </div>
          <ChartAreaSkeleton />
        </div>
      ) : view.state === "notFound" ? (
        <p className="pt-20 text-center text-sm text-muted-foreground">
          {copy.profile.notFound}
        </p>
      ) : (
        <div className="mt-8">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              {copy.profile.focusPerDay}
            </h2>
            <div className="flex" role="group">
              {RANGES.map((r) => (
                <Button
                  key={r}
                  size="xs"
                  variant={range === r ? "secondary" : "ghost"}
                  aria-pressed={range === r}
                  onClick={() => setRange(r)}
                  className={range === r ? "" : "text-muted-foreground"}
                >
                  {t(copy.profile.rangeDays, { n: faDigits(r) })}
                </Button>
              ))}
            </div>
          </div>

          {view.state === "reloading" ? (
            <ChartAreaSkeleton />
          ) : view.state === "empty" ? (
            <EmptyRange username={view.username} banners={banners} />
          ) : (
            <>
              <div className="mt-4">
                <FocusChart
                  days={view.days}
                  selectedKey={view.selectedKey}
                  onSelect={setHovered}
                />
              </div>

              {/* Keyed by day, so moving between two days fades as well —
                  every card is its own arrival and departure. `wait` holds the
                  incoming one until the outgoing has gone: the two cards differ
                  in height with the category list, and running them together
                  would shunt the page around mid-fade. */}
              <AnimatePresence mode="wait">
                {view.selected && (
                  <motion.div
                    key={view.selected.dayKey}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    // `wait` means a scrub pays this twice per day crossed.
                    transition={{ duration: 0.3, ease: "easeOut" }}
                  >
                    <DayCard
                      day={view.selected}
                      username={view.username}
                      banners={banners}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </div>
      )}
    </main>
  );
}
