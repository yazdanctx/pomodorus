// Which image a day card shows.
//
// The draw is remembered for the page visit rather than the card's lifetime:
// changing Range unmounts the card while the new range loads, and a day whose
// art came back different every time would read as a glitch. That memory is the
// point of this module — the random pick on its own is a one-liner.

/** A page visit's record of which image each key was given. */
export type BannerAssignment = {
  /**
   * The image for `key`, drawn the first time it is asked for and kept from
   * then on, so pointing back and forth along the chart never reshuffles the
   * art. Null when there is nothing to show.
   */
  for(key: string): string | null;
  /**
   * Draw `key` again, away from the picture it is showing now, and tell
   * everyone reading this assignment.
   */
  reroll(key: string): void;
  /** Called after a reroll. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
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
  const listeners = new Set<() => void>();
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
      remaining = banners.filter((b) => b !== lastDrawn);
      // With a single image there is nothing to rotate to, so repeat it.
      if (remaining.length === 0) remaining = [...banners];
    }
    const index = Math.floor(random() * remaining.length);
    const [picked] = remaining.splice(index, 1);
    lastDrawn = picked;
    return picked;
  }

  function imageFor(key: string): string | null {
    const seen = assigned.get(key);
    if (seen !== undefined) return seen;
    const picked = draw();
    if (picked === null) return null;
    assigned.set(key, picked);
    return picked;
  }

  return {
    for: imageFor,
    reroll(key) {
      const current = assigned.get(key);
      assigned.delete(key);
      if (current !== undefined) {
        // The picture on screen is the one to move away from, whatever other
        // days drew in between — both for the refill above and for the pool,
        // which may have been handed it back by an earlier refill. Dropping it
        // costs it this cycle only; the next refill has it again.
        lastDrawn = current;
        const held = remaining.indexOf(current);
        if (held !== -1) remaining.splice(held, 1);
      }
      imageFor(key);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// One assignment per banner list for the life of the page, so every card drawn
// on that page shares one history of draws.
const byList = new Map<string, BannerAssignment>();

/** The visit's assignment over `banners`. The app's binding of the factory. */
export function bannerAssignment(banners: readonly string[]): BannerAssignment {
  const listKey = banners.join("\n");
  let assignment = byList.get(listKey);
  if (assignment === undefined) {
    assignment = createBannerAssignment(banners);
    byList.set(listKey, assignment);
  }
  return assignment;
}
