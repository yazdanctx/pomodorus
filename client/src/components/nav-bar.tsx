import { Timer } from "lucide-react";
import { Link, useLocation } from "react-router";

import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import { copy } from "@/lib/copy";

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
        <Button asChild size="sm" variant="outline">
          <Link to="/app" className="hover:text-foreground">
            <Timer size={15} />
            {copy.header.timer}
          </Link>
        </Button>
        <AuthCta auth={auth} />
      </nav>
    </header>
  );
}

function AuthCta({ auth }: { auth: ReturnType<typeof useAuth> }) {
  if (auth.status === "loading") {
    return <Skeleton className={CTA_BOX} data-testid="nav-cta-placeholder" />;
  }

  // Signed in without a handle yet: there is no profile to link to, so the CTA
  // points back at the app, which is where the claim step lives.
  const to =
    auth.status === "authenticated"
      ? auth.handle === null
        ? "/app"
        : `/u/${auth.handle}`
      : "/login";
  const label =
    auth.status === "authenticated"
      ? auth.handle === null
        ? copy.header.timer
        : copy.header.myProfile
      : copy.landing.enter;

  return (
    <Button asChild size="sm" variant="outline" className={CTA_BOX}>
      <Link to={to}>{label}</Link>
    </Button>
  );
}
