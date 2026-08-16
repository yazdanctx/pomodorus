import { Link } from "react-router";

import { copy } from "@/lib/copy";

/**
 * The two-step email-code form arrives in #11. The wordmark and the way back
 * are here because they are frame, not flow.
 */
export function LoginRoute() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-light tracking-widest uppercase text-yellow-600">
        {copy.app.name}
      </h1>
      <Link
        to="/"
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        {copy.login.backHome}
      </Link>
    </main>
  );
}
