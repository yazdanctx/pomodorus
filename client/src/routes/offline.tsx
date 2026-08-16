import { Link } from "react-router";

import { buttonVariants } from "@/components/ui/button-variants";
import { copy } from "@/lib/copy";
import { cn } from "@/lib/utils";

/**
 * The service worker's navigation fallback, shown when a page is opened with
 * no network. The worker that reaches it arrives in #25; the page is here
 * because it is v1 markup and copy that would otherwise have to be
 * reconstructed later.
 *
 * The heading's `text-2xl font-black` is v1's, ported verbatim. It is not a
 * row in the type scale in docs/design-tokens.md because that table records
 * the scale's shared roles, not every one-off — and the design is fixed, so
 * the v1 markup wins over a value picked to fit the table.
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
