import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * How every failure in this app is put in front of somebody.
 *
 * The theme is monochrome, so it cannot be red — it separates itself from the
 * grey hints around it by being full white, boxed and iconned instead. The
 * live region is always present rather than appearing with the message,
 * because a region that arrives at the same time as its content is not
 * reliably announced.
 */
export function Failure({ message }: { message: string | null }) {
  return (
    <div aria-live="polite">
      {message && (
        <Alert className="text-foreground">
          <TriangleAlert />
          <AlertDescription className="text-foreground">
            {message}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
