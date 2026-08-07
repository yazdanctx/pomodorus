// Server-only: lists the banner images on disk so dropping a new file into
// public/banners is all it takes to add one. Keep this out of client bundles —
// the pure picking logic lives in ./banners.

import { readdirSync } from "node:fs";
import { join } from "node:path";

const IMAGE = /\.(avif|webp|png|jpe?g|gif)$/i;

// Read once per server process; the directory only changes on deploy.
let cached: string[] | undefined;

/**
 * Every image in public/banners as a URL path, sorted by filename.
 *
 * The sort is lexicographic, so the files are named `frieren-NN.avif` with the
 * number zero-padded and contiguous — unpadded, `frieren-10` would sort ahead
 * of `frieren-4`. Name a new one for the next free number.
 */
export function listBanners(): string[] {
  if (cached !== undefined) return cached;
  let files: string[] = [];
  try {
    files = readdirSync(join(process.cwd(), "public", "banners"));
  } catch {
    // Directory missing or unreadable: the profile just renders no banner.
  }
  cached = files
    .filter((name) => IMAGE.test(name))
    .sort()
    .map((name) => `/banners/${name}`);
  return cached;
}
