/**
 * The tomato on its own — the app's mark with the squircle tile, its gradient
 * and its edge stroke dropped.
 *
 * The tile exists to sit on a dock or a home screen; inside the app it would
 * be a rounded box in a UI with `--radius: 0rem`, on a background it already
 * matches. So the nav draws the line-art alone, inline and in `currentColor`,
 * which also means it tracks the foreground and has no load state to shift
 * around. The viewBox is cropped to the artwork so the glyph fills its box
 * rather than floating in the tile's padding.
 *
 * This is the one place the mark appears without its tile; `public/icon.svg`
 * and `scripts/` remain the source for the favicon, PWA and apple-touch icons.
 */
export function Logo({ className = "size-8" }: { className?: string }) {
  return (
    <svg
      viewBox="88 105 336 336"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={26}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <ellipse cx="256" cy="308" rx="132" ry="118" />
      <path d="M256 196 C 236 170, 196 160, 158 176" />
      <path d="M256 196 C 276 170, 316 160, 354 176" />
      <path d="M256 196 C 250 168, 258 138, 286 120" />
    </svg>
  );
}
