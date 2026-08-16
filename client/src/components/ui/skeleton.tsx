import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Square, not rounded. v1's component carried shadcn's `rounded-md` and every
 * call site overrode it; the radius lives here now so there is nothing to
 * override and nothing to forget.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-none bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
