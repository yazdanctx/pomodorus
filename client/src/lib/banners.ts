/**
 * Which image a day detail shows.
 *
 * The pictures are content, not decoration with a rule behind it: the point is
 * that a day somebody looks at is given one, and that it stays that day's for
 * as long as they are on the page. Pointing along the chart walks through days
 * one per mouse move, and art that came back different every time would read
 * as a glitch rather than as a picture.
 *
 * The draw is remembered for the visit rather than for a component's lifetime,
 * because switching range unmounts the panel while the new range loads.
 */

/**
 * Every image in `assets/banners`, sorted by filename.
 *
 * Enumerated at build time rather than listed by hand, so dropping a file into
 * that folder is all it takes to add one — which is why these live under `src`
 * and not in `public`, where nothing can see them but a URL written out in
 * full. Vite hashes and copies them from here; they are already hand-optimised
 * AVIF at around ten kilobytes each, and nothing re-encodes them.
 *
 * The sort is lexicographic, so the files are named `frieren-NN.avif` with the
 * number zero-padded — unpadded, `frieren-10` would sort ahead of `frieren-4`.
 * Name a new one for the next free number.
 */
export const BANNERS: string[] = Object.entries(
  import.meta.glob<string>("../assets/banners/*.avif", {
    eager: true,
    query: "?url",
    import: "default",
  }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => url);

/** A visit's record of which image each day was given. */
export type BannerAssignment = {
  /**
   * The image for `key`, drawn the first time it is asked for and kept from
   * then on, so pointing back and forth along the chart never reshuffles the
   * art. Null when there is nothing to show.
   */
  for(key: string): string | null;
};

/**
 * A fresh assignment over `banners`. Pass `random` to make the draws
 * deterministic; the app uses the default.
 */
export function createBannerAssignment(
  banners: readonly string[],
  random: () => number = Math.random,
): BannerAssignment {
  const assigned = new Map<string, string>();
  // Draws come out of a pool that is emptied before it is refilled, so a
  // visitor sees every picture once before seeing any of them twice. That is
  // as unique as it gets with a fixed folder of images: past `banners.length`
  // days there is nothing left to be unique with.
  let remaining: string[] = [];
  let lastDrawn: string | null = null;

  function draw(): string | null {
    if (banners.length === 0) return null;
    if (remaining.length === 0) {
      // Hold back the picture just drawn, so the wrap-around isn't the one
      // place two neighbouring days land on the same art.
      remaining = banners.filter((banner) => banner !== lastDrawn);
      // With a single image there is nothing to rotate to, so repeat it.
      if (remaining.length === 0) remaining = [...banners];
    }
    const index = Math.floor(random() * remaining.length);
    const [picked] = remaining.splice(index, 1);
    // The pool was just refilled if it was empty, so this always draws
    // something; the check is what the type says rather than a case.
    if (picked === undefined) return null;
    lastDrawn = picked;
    return picked;
  }

  return {
    for(key) {
      const seen = assigned.get(key);
      if (seen !== undefined) return seen;
      const picked = draw();
      if (picked === null) return null;
      assigned.set(key, picked);
      return picked;
    },
  };
}

// One assignment per banner list for the life of the page, so every day drawn
// on it shares one history of draws — including across a range switch, which
// unmounts the panel.
const byList = new Map<string, BannerAssignment>();

/**
 * The visit's assignment over `banners`, defaulting to the folder.
 *
 * The app's binding of the factory: module state, because "for this visit" is
 * what the memory is *of*, and a component that owned it would forget on every
 * unmount.
 */
export function bannerAssignment(
  banners: readonly string[] = BANNERS,
): BannerAssignment {
  const listKey = banners.join("\n");
  let assignment = byList.get(listKey);
  if (assignment === undefined) {
    assignment = createBannerAssignment(banners);
    byList.set(listKey, assignment);
  }
  return assignment;
}
