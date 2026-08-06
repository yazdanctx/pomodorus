"use client";

import { useConvexAuth } from "convex/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BellRing, Scan, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { copy } from "@/lib/copy";
import { faClock } from "@/lib/format";
import {
  useLocalIdentity,
  useLocalState,
  useTimerNow,
} from "@/lib/local/hooks";
import { endAt } from "@/lib/local/types";

const HIDE_ON = ["/login", "/offline"];

// Both auth CTAs and the placeholder that stands in for them share one box, so
// the bar is exactly as tall and the CTA exactly as wide before the auth state
// resolves as after. Wide enough for the longer of «لاگین کن» and «پروفایل».
const CTA_BOX = "h-8 min-w-24";

/**
 * The tomato on its own — the app's mark with the squircle tile, its gradient
 * and its edge stroke dropped.
 *
 * The tile exists to sit on a dock or a home screen; inside the app it is a
 * rounded box in a UI with `--radius: 0rem`, on a background it already
 * matches. So the nav draws the line-art alone, inline and in `currentColor`,
 * which also means it tracks the foreground and has no load state to shift
 * around. The viewBox is cropped to the artwork so the glyph fills its box
 * rather than floating in the tile's padding.
 *
 * This is the one place the mark appears without its tile; `/icon.svg` and
 * `scripts/` remain the source for the favicon, PWA and apple-touch icons.
 */
function Logo() {
  return (
    <svg
      viewBox="88 105 336 336"
      className="size-8"
      fill="none"
      stroke="currentColor"
      strokeWidth={26}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <ellipse cx="256" cy="308" rx="132" ry="118" />
      <path d="M256 196 C 236 170, 196 160, 158 176" />
      <path d="M256 196 C 276 170, 316 160, 354 176" />
      <path d="M256 196 C 250 168, 258 138, 286 120" />
    </svg>
  );
}

export function NavBar() {
  const pathname = usePathname();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const username = useLocalIdentity();
  const state = useLocalState();
  const now = useTimerNow();

  // How long the placeholder is willing to wait for the cached username
  // before settling for a link that always works.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  if (HIDE_ON.includes(pathname)) return null;

  const running = state.running;
    const ringing = state.ringing;
    const remainingMs = running ? Math.max(0, endAt(running, now) - now) : null;

  return (
    // h-14 rather than padding alone: the bar keeps its height even in the
    // beat before the auth state resolves, so nothing below it ever moves.
    <header className="flex h-14 w-full shrink-0 items-center justify-between px-6">
      <Link href="/" aria-label={copy.app.name}>
        <Logo />
      </Link>
      {/* The timer always links to the app; a running session swaps the
          label for the live countdown. The badge sits inline-start of the
          CTA, so it materialises into empty space rather than pushing the
          CTA off the frame edge.

          A ringing session keeps the badge rather than losing it — that is
          the moment you most need a way back in, and an alarm you cannot
          hear (a reload suspends audio) may be the only thing showing. It
          counts *up*, which is the opposite of what this badge otherwise
          means, so it goes red and belled rather than outlined and scanned:
          the inversion has to be legible at a glance, not just in the
          digits. */}
      <nav className="flex items-center gap-2 text-sm text-muted-foreground">
        <Button asChild size="sm" variant="outline">
          <Link
            href="/app"
            className={
              ringing ? "text-rose-500 animate-pulse" : "hover:text-foreground"
            }
          >
            {ringing ? (
              <>
                <span
                  className="w-10 flex justify-start font-mono tabular-nums"
                  dir="ltr"
                >
                  +{faClock(now - ringing.endedAt)}
                </span>
                <BellRing size={15} />
              </>
            ) : remainingMs !== null ? (
              <>
                <span
                  className="w-10 flex justify-start font-mono tabular-nums"
                  dir="ltr"
                >
                  {faClock(remainingMs)}
                </span>
                <Scan size={15} className="text-rose-500 animate-pulse" />
              </>
            ) : (
              <>
                <Timer size={15} />
                {copy.header.timer}
              </>
            )}
          </Link>
        </Button>
        {/* Signed in but the username hasn't arrived yet is still "loading":
            guessing here is what used to flash the wrong CTA. It falls back
            to the timer once auth has settled, so a device that can't reach
            profiles.me is left with a working link rather than a pulse. */}
        {isLoading || (isAuthenticated && username === null && !settled) ? (
          <Skeleton className={`${CTA_BOX} rounded-none`} />
        ) : isAuthenticated ? (
          <Button asChild size="sm" variant="outline" className={CTA_BOX}>
            <Link href={username === null ? "/app" : `/u/${username}`}>
              {username === null ? copy.header.timer : copy.header.myProfile}
            </Link>
          </Button>
        ) : (
          <Button asChild size="sm" variant="outline" className={CTA_BOX}>
            <Link href="/login">{copy.landing.enter}</Link>
          </Button>
        )}
      </nav>
    </header>
  );
}
