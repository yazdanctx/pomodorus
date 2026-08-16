import type { ReactNode } from "react";
import { Navigate } from "react-router";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import { ClaimHandleRoute } from "@/routes/claim-handle";

/**
 * The gate in front of everything that needs a name.
 *
 * An account exists from the moment its address is verified, before a handle
 * is picked — such a user is signed in but appears nowhere public, so they are
 * sent to claim one and cannot reach the timer first. There is nothing stored
 * on the device about which step they are on: the server's answer to "who are
 * you" is the whole of it, which is why abandoning and returning resumes here.
 */
export function RequireHandle({ children }: { children: ReactNode }) {
  const auth = useAuth();

  if (auth.status === "loading") {
    // Reserving the page rather than rendering nothing, so the answer arrives
    // into a box the right shape instead of pushing the frame around.
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-6 p-4 sm:p-6">
        <Skeleton className="h-40 w-full max-w-xs" />
      </main>
    );
  }
  if (auth.status === "anonymous") {
    return <Navigate to="/login" replace />;
  }
  if (auth.handle === null) {
    return <ClaimHandleRoute />;
  }
  return children;
}
