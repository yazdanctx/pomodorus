import { copy } from "@/lib/copy";

/**
 * The hero, the pitch, the CTA pair, the personal note and the live feed all
 * land here in #19. This ticket owns the frame the route sits in, not its
 * contents.
 */
export function LandingRoute() {
  return (
    <main className="flex flex-1 flex-col gap-8 px-6 pb-10 sm:gap-10">
      <h1 className="text-center text-3xl font-light tracking-widest uppercase text-yellow-600 lg:text-6xl">
        {copy.landing.tagline}
      </h1>
      <p className="text-center text-sm sm:text-base md:text-lg">
        {copy.landing.pitch}
      </p>
    </main>
  );
}
