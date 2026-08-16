import { useParams } from "react-router";

import { enDigits } from "@/lib/format";

/**
 * The focus chart and the day detail arrive in #21 and #22.
 *
 * A handle is Latin by construction, so it renders through `enDigits` and out
 * of the Persian face — a Persian digit reaching one would be a bug, and one
 * that read as a different name.
 */
export function ProfileRoute() {
  const { handle = "" } = useParams();
  return (
    <main className="flex flex-1 flex-col gap-6 p-6">
      <h1 className="text-base font-medium [font-family:ui-sans-serif,system-ui,sans-serif]">
        {enDigits(handle)}
      </h1>
    </main>
  );
}
