import Image from "next/image";
// A fixed image rather than a draw from lib/banners like the profile does: a
// random pick would either pop in on the client or vary per request, and the
// hero is the first thing painted.
//
// Imported rather than written as a path so the URL carries a content hash.
// Note Turbopack can't decode AVIF, so the import is only ever a string — no
// intrinsic width/height and no blurDataURL — which is why the image is sized
// by its wrapper below instead of by the import.
import hero from "@/public/main.avif";
import Link from "next/link";
import { FaGithub } from "react-icons/fa6";
import { Feed } from "@/components/feed";
import { LandingCta } from "@/components/landing-cta";
import { MotivationButton } from "@/components/motivation-button";
import { buttonVariants } from "@/components/ui/button-variants";
import { copy } from "@/lib/copy";
import { cn } from "@/lib/utils";

const REPO_URL = "https://github.com/yazdanctx/pomodorus";

export function Landing() {
  return (
    <main className="flex flex-1 flex-col">
      {/* <div className="mx-6 mt-4"> */}
      {/*   <div className="rounded-lg border border-yellow-600/30 bg-yellow-600/10 backdrop-blur-sm px-4 py-3 text-center"> */}
      {/*     <p className="text-sm sm:text-base text-yellow-600/90 leading-relaxed"> */}
      {/*       یه{" "} */}
      {/*       <span className="font-medium text-yellow-600">Hard Refresh</span>{" "} */}
      {/*       بزنید — فیچرهای جدید اضافه شده و ممکنه لود نشده باشه */}
      {/*     </p> */}
      {/*     <p className="text-sm text-yellow-600/70 mt-1.5 font-mono tracking-wide"> */}
      {/*       <span className="hidden sm:inline">Ctrl + Shift + R</span> */}
      {/*       <span className="sm:hidden">⌘ + Shift + R</span> */}
      {/*       <span className="mx-1.5 text-yellow-600/40">|</span> */}
      {/*       <span className="hidden sm:inline">Command + Shift + R</span> */}
      {/*       <span className="sm:hidden">Ctrl + Shift + R</span> */}
      {/*     </p> */}
      {/*     <p className="text-sm text-yellow-600/60 mt-1.5"> */}
      {/*       باگی دیدی؟{" "} */}
      {/*       <a */}
      {/*         href="https://t.me/antimatter0x1" */}
      {/*         target="_blank" */}
      {/*         rel="noopener noreferrer" */}
      {/*         className="underline underline-offset-2 decoration-yellow-600/40 hover:text-yellow-600 hover:decoration-yellow-600/80 transition-colors" */}
      {/*       > */}
      {/*         بهم پیام بده */}
      {/*       </a> */}
      {/*     </p> */}
      {/*   </div> */}
      {/* </div> */}
      {/**/}
      {/* Full-bleed to the content frame and cropped to a band: the source is
          square, and a square at this width would push everything that says
          what the app is below the fold. The wrapper owns the box, so the
          space is reserved before the image has loaded or been measured. */}
      <div className="relative overflow-hidden aspect-video w-full shrink-0 mt-5">
        {/* The title sits in the bottom of the scrim, where the gradient is
            opaque background — the only band where the type is legible
            whatever the image is doing behind it. The inset keeps a wide
            tracking-widest title off the frame edges. */}
        <div className="absolute left-0 right-0 top-0 bottom-0 z-5 bg-linear-to-t items-end via-background/50 from-background to-transparent flex justify-center px-6 pb-4">
          <h1 className="lg:text-6xl text-3xl text-center tracking-widest font-light uppercase text-yellow-600">
            {copy.landing.tagline}
          </h1>
        </div>
        <Image
          src={hero}
          alt=""
          fill
          // `priority` is deprecated as of Next 16; `preload` is the same
          // <link rel=preload> for what is unambiguously the LCP element.
          preload
          // The source is an already-optimal 11KB AVIF at 941px. Running it
          // through the optimizer re-encodes it to a 34KB WebP (42KB JPEG for
          // older clients) — three times the bytes for the LCP image.
          unoptimized
          sizes="(max-width: 36rem) 100vw, 36rem"
          className="object-cover"
        />
      </div>

      <div className="flex flex-col gap-8 px-6 pb-10 sm:gap-10">
        <section className="flex flex-col items-center gap-4">
          <p className="text-center text-sm md:text-lg  sm:text-base">
            {copy.landing.pitch}
          </p>
          <div className="mt-2 flex flex-col items-center gap-3 sm:flex-row sm:gap-4">
            <LandingCta />
            <Link
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className={cn(
                buttonVariants({ variant: "outline", size: "lg" }),
                "h-11 w-40",
              )}
            >
              <FaGithub className="size-5" />
              {copy.landing.github}
            </Link>
            <MotivationButton />
          </div>
        </section>

        <div className="h-0.5 bg-linear-to-r from-transparent via-border to-transparent" />

        <p className="text-xs leading-7 text-muted-foreground sm:text-sm sm:leading-8">
          {copy.landing.sub}
        </p>

        <Feed />
      </div>
    </main>
  );
}
