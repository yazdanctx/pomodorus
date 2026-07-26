import Link from "next/link";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { copy } from "@/lib/copy";

// The service worker's navigation fallback: shown when an uncached page
// (e.g. someone's profile) is opened with no network. The timer itself
// never lands here — /app is cached on every visit. Kept free of client
// components so it stays a fully static page.
export default function OfflinePage() {
  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-black tracking-tight">{copy.offline.pageTitle}</h1>
      <p className="text-sm leading-7 text-muted-foreground">{copy.offline.pageBody}</p>
      {/* buttonVariants rather than <Button asChild>: keeps the CTA on the
          shared button scale while the page stays a server component. */}
      <Link href="/app" className={cn(buttonVariants({ size: "lg" }), "mt-2")}>
        {copy.offline.pageCta}
      </Link>
    </main>
  );
}
