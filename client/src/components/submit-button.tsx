import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * A submit that says it is working. The label changes with it rather than the
 * spinner appearing beside the old one, because "بزن بریم" next to a spinner
 * reads as a button you can press again.
 */
export function SubmitButton({
  pending,
  label,
  pendingLabel,
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
}) {
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? (
        <>
          <Loader2 className="animate-spin" />
          {pendingLabel}
        </>
      ) : (
        label
      )}
    </Button>
  );
}
