import type * as React from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Square like everything else, and filled with the same `primary` the switch
 * used before it. The `after:-inset-x-2 after:-inset-y-2` pseudo-element is the
 * enlarged touch target: the visible box is `16px` and is meant to stay that
 * small, so only the invisible part grows.
 *
 * The state variants are keyed to `data-[state=…]`, which is the attribute
 * Radix actually writes — a bare `data-checked:` matches the attribute's
 * presence and so matches always.
 */
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative size-4 shrink-0 rounded-none border border-input bg-input/30 transition-colors outline-none after:absolute after:-inset-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
