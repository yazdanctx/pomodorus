import { Route, Routes } from "react-router";

import { NavBar } from "@/components/nav-bar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, type AuthValue } from "@/lib/auth";
import { LandingRoute } from "@/routes/landing";
import { LoginRoute } from "@/routes/login";
import { OfflineRoute } from "@/routes/offline";
import { ProfileRoute } from "@/routes/profile";
import { TimerRoute } from "@/routes/timer";

/**
 * The frame every screen sits inside: a centred column, thin side borders on
 * large screens only, a dark stone surround on desktop and flush black on a
 * phone. It is `min-h-screen` and a flex column so a route can claim the
 * remaining height with `flex-1` without measuring anything.
 */
const FRAME =
  "mx-auto overflow-x-hidden flex min-h-screen w-full max-w-xl flex-col border-x-0 bg-background lg:border-x lg:border-border/50";

export function App({ auth }: { auth?: AuthValue }) {
  return (
    <AuthProvider value={auth}>
      <TooltipProvider>
        <div className={FRAME}>
          <NavBar />
          <Routes>
            <Route path="/" element={<LandingRoute />} />
            <Route path="/login" element={<LoginRoute />} />
            <Route path="/app" element={<TimerRoute />} />
            <Route path="/u/:handle" element={<ProfileRoute />} />
            <Route path="/offline" element={<OfflineRoute />} />
            {/* An unknown path is a mistyped or stale link, and the landing
                is the only page that explains what this is. */}
            <Route path="*" element={<LandingRoute />} />
          </Routes>
        </div>
      </TooltipProvider>
    </AuthProvider>
  );
}
