import { BellRing, Scan, Timer } from "lucide-react";
import { Link, useLocation } from "react-router";

import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth, type Auth } from "@/lib/auth";
import { copy } from "@/lib/copy";
import { faClock, faElapsed } from "@/lib/format";
import { useTick } from "@/lib/server-clock";
import { isRinging, useSession } from "@/lib/session";

/** The two screens that are their own whole page and carry no chrome. */
const HIDE_ON = ["/login", "/offline"];

/**
 * Both auth CTAs and the placeholder standing in for them share one box, so
 * the bar is exactly as wide before the auth state resolves as after. Wide
 * enough for the longer of «لاگین کن» and «پروفایل» — the placeholder reserves
 * the space without predicting which label wins, which is what stops the flash
 * of the wrong CTA that guessing used to cause.
 */
const CTA_BOX = "h-8 min-w-24";

export function NavBar() {
  const { pathname } = useLocation();
  const auth = useAuth();

  if (HIDE_ON.includes(pathname)) return null;

  return (
    // h-14 rather than padding alone: the bar keeps its height even in the
    // beat before the auth state resolves, so nothing below it ever moves.
    <header className="flex h-14 w-full shrink-0 items-center justify-between px-6">
      <Link to="/" aria-label={copy.app.name}>
        <Logo />
      </Link>
      <nav className="flex items-center gap-2 text-sm text-muted-foreground">
        <TimerCta />
        <AuthCta auth={auth} />
      </nav>
    </header>
  );
}

/**
 * The way back to the timer, and — while one is live — what it is doing.
 *
 * A running session swaps the label for the countdown. A ringing one keeps the
 * badge rather than losing it: that is the moment you most need a way back in,
 * and on a reloaded tab, where audio is suspended until you touch the page, it
 * may be the only thing saying so. It counts *up*, which is the opposite of
 * what this badge otherwise means, so it inverts — red and belled rather than
 * plain and scanned. The inversion has to be legible at a glance, not just in
 * the digits.
 *
 * The digits sit in a fixed box so the CTA beside them does not shuffle every
 * time a minute rolls over — and the badge reserves that box while the answer
 * is still on its way, rather than guessing at «تایمر» and swapping to a
 * countdown a beat later on every mid-pomodoro reload.
 */
function TimerCta() {
  const { session } = useSession();
  const now = useTick();

  // min-w rather than w: it reserves the digits' box so a rolling minute does
  // not shuffle the CTA beside it, while a ring hours old (+۱۸۰:۰۰) is still
  // allowed to grow rather than spill out of it.
  const clock = "flex min-w-10 justify-start tabular-nums";

  if (session === undefined) {
    return <Skeleton className={CTA_BOX} data-testid="nav-timer-placeholder" />;
  }

  if (session === null) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link to="/app" className="hover:text-foreground">
          <Timer size={15} />
          {copy.header.timer}
        </Link>
      </Button>
    );
  }

  if (isRinging(session, now)) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link to="/app" className="animate-pulse text-rose-500">
          <span className={clock} dir="ltr">
            {faElapsed(now - session.endsAt)}
          </span>
          <BellRing size={15} />
        </Link>
      </Button>
    );
  }

  return (
    <Button asChild size="sm" variant="outline">
      <Link to="/app" className="hover:text-foreground">
        <span className={clock} dir="ltr">
          {faClock(session.endsAt - now)}
        </span>
        <Scan size={15} />
      </Link>
    </Button>
  );
}

function AuthCta({ auth }: { auth: ReturnType<typeof useAuth> }) {
  if (auth.status === "loading") {
    return <Skeleton className={CTA_BOX} data-testid="nav-cta-placeholder" />;
  }

  const { to, label } = destination(auth);
  return (
    <Button asChild size="sm" variant="outline" className={CTA_BOX}>
      <Link to={to}>{label}</Link>
    </Button>
  );
}

/** Where the CTA goes and what it says — decided once, from one state. */
function destination(auth: Auth): { to: string; label: string } {
  if (auth.status !== "authenticated") {
    return { to: "/login", label: copy.landing.enter };
  }
  // Signed in without a handle yet: there is no profile to link to, so the CTA
  // points back at the app, which is where the claim step lives.
  if (auth.handle === null) {
    return { to: "/app", label: copy.header.timer };
  }
  return { to: `/u/${auth.handle}`, label: copy.header.myProfile };
}
