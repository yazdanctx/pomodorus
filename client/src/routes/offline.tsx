import { Link } from "react-router";

import { buttonVariants } from "@/components/ui/button-variants";
import { copy } from "@/lib/copy";
import { cn } from "@/lib/utils";

/**
 * The service worker's navigation fallback: shown when an uncached page is
 * opened with no network.
 */
export function OfflineRoute() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-black tracking-tight">
        {copy.offline.pageTitle}
      </h1>
      <p className="text-sm leading-7 text-muted-foreground">
        {copy.offline.pageBody}
      </p>
      <Link to="/app" className={cn(buttonVariants({ size: "lg" }), "mt-2")}>
        {copy.offline.pageCta}
      </Link>
    </main>
  );
}
