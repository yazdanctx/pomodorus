import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The one box used for anything the user must actually read — a login
 * failure, the standing experimental notice, a profanity refusal.
 *
 * There is deliberately no error variant. The theme is monochrome and
 * `--destructive` is the same grey as `--muted-foreground`, so an error may
 * not separate itself by hue: it separates itself by being full white, boxed
 * and iconned instead. Pass `className="text-foreground"` on the alert and its
 * description, and put a `TriangleAlert` inside — which is what `Failure`
 * does, and what every error in the app goes through.
 */
const ALERT =
  "group/alert relative grid w-full gap-0.5 rounded-none border bg-card px-2.5 py-2 text-start text-sm text-card-foreground has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4";

function Alert({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(ALERT, className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
