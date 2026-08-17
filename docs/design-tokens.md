# Design tokens — the pixel target for the rewrite

Extracted from the Next.js app at commit `fadda7a`, before the wipe. The
rewrite matches this. Where a value looks arbitrary the reason is recorded,
because "round it to something nicer" is exactly how a pixel-identical port
stops being one.

The old app is still in git history: `git show v1-nextjs:app/globals.css`.

---

## Root

| | |
| --- | --- |
| `lang` | `fa` |
| `dir` | `rtl` |
| Font family | Peyda FaNum Web, local `.woff2`, weights 100–950 (10 files) |
| Root font size | `106.25%` (17px), rising to `112.5%` (18px) at `≥40rem` |
| Body | `min-h-screen flex flex-col lg:bg-stone-950`, `antialiased` |
| Theme color | `#000000` |

The root font size is a **global scale-up**, not a type choice: everything is
rem-based, so type, spacing and control heights grow together. 16px was too
small for Persian text. It's held one notch down on phones because at 18px the
timer's `−/clock/+` row overflows a 360px frame. The breakpoint is `40rem`,
matching Tailwind `sm` — rem inside a media query is always the browser's 16px,
never this value.

## Color

One fixed theme. No light mode, no toggle, no `dark:` variants in play.

```css
--background:        oklch(0 0 0);      /* pitch black */
--foreground:        oklch(1 0 0);      /* pure white */
--card:              oklch(0 0 0);
--card-foreground:   oklch(1 0 0);
--popover:           oklch(0 0 0);
--popover-foreground:oklch(1 0 0);
--primary:           oklch(1 0 0);
--primary-foreground:oklch(0 0 0);
--secondary:         oklch(0.2 0 0);
--secondary-foreground: oklch(1 0 0);
--muted:             oklch(0.2 0 0);
--muted-foreground:  oklch(0.65 0 0);
--accent:            oklch(0.2 0 0);
--accent-foreground: oklch(1 0 0);
--destructive:       oklch(0.65 0 0);   /* deliberately == muted-foreground */
--input:             oklch(1 0 0 / 22%);
--ring:              oklch(0.65 0 0);
--radius:            0rem;

--chart-1: oklch(0.87 0 0);
--chart-2: oklch(0.556 0 0);
--chart-3: oklch(0.439 0 0);
--chart-4: oklch(0.371 0 0);
--chart-5: oklch(0.269 0 0);
```

Border is set in `@theme inline`, not as a `:root` variable:
`--color-border: hsl(24 6% 25%)`. It is the one non-neutral value in the
palette — a faintly warm grey — and it does not follow the oklch scheme the
rest of the tokens use. Keep it exactly.

### The hue rules

1. **`--destructive` is the same grey as `--muted-foreground`.** The theme is
   monochrome, so an error may not separate itself by hue. It separates itself
   by being **full white, boxed and iconned** instead (`Alert` +
   `TriangleAlert` + `className="text-foreground"`).
2. **One exception in the whole app: a ringing timer is `rose-500`.** The ring
   clock and the NavBar badge, nothing else ever. A clock that has stopped
   meaning "time left" and started counting up has to be unmistakable across a
   room.
3. **`yellow-600` is used for the wordmark only** — the hero title on the
   landing and the `Pomodorus` heading on the login page. It is not available
   to anything else.

## Shape

- `--radius: 0rem`. Every derived radius (`sm/md/lg/xl/2xl/3xl/4xl`) computes
  off it, so they are all `0`. Components additionally hard-code
  `rounded-none` in many places; keep both, since a stray shadcn default is
  otherwise one upgrade away from reappearing.
- **No shadows anywhere.** Depth is not part of this design.
- **No dividing rules between page sections** — spacing does the separating.
  The exceptions are deliberate and few: the feed's `divide-y`, the dialog
  footer's `border-t`, and the landing's one gradient hairline.

## Layout

**Content frame** — a centered column, thin side borders on large screens
only, dark stone surround on desktop, flush black on mobile:

```
mx-auto overflow-x-hidden flex min-h-screen w-full max-w-xl flex-col
border-x-0 bg-background lg:border-x lg:border-border/50
```

`body` carries `overflow-x: clip` as a backstop — `clip` rather than `hidden`,
because `hidden` would make the body a scroll container and break
`position: sticky`.

**NavBar** — `flex h-14 w-full shrink-0 items-center justify-between px-6`.
The fixed `h-14` matters: the bar keeps its height in the beat before auth
resolves, so nothing below it ever moves. Hidden on `/login` and `/offline`.

**NavBar timer badge** — the way back to the timer, in three states. Idle it is
`Timer` + «تایمر». Running it swaps the label for the countdown and the icon
for `Scan`. Ringing it inverts: `+mm:ss` counting up, `BellRing`, and
`animate-pulse text-rose-500` on the link. The digits sit in a
`flex min-w-10 justify-start font-mono tabular-nums` box, and while the live
session is still unknown the badge holds the CTA box (`h-8 min-w-24`) as a
skeleton — the same reserved-box rule as the auth CTA, so a mid-pomodoro reload
does not flash «تایمر» and then swap to a countdown.

v1 also tinted the *running* badge's `Scan` icon `rose-500` (visible in
`docs/reference/*/10-running-work.png`). That is dropped: the colour rule above
gives the hue to the ring alone, and a badge that is already red cannot invert
into one.

**Page padding** — `p-6` is the standard page inset; the timer uses
`p-4 sm:p-6`.

## Type scale

| Role | Classes |
| --- | --- |
| Hero / wordmark | `text-3xl lg:text-6xl text-center tracking-widest font-light uppercase text-yellow-600` |
| Login wordmark | `text-2xl font-light tracking-widest uppercase text-yellow-600` |
| Running + ring clock | `font-mono text-6xl font-bold tabular-nums tracking-tight sm:text-7xl` |
| Start-screen clock | `font-mono text-5xl font-bold tabular-nums tracking-tight sm:text-7xl` |
| Ring headline | `text-3xl font-semibold tracking-tight sm:text-4xl` |
| Day-detail total | `text-4xl leading-none font-bold sm:text-6xl` |
| Section heading | `text-base font-medium` |
| Body | inherited (`text-sm` in most panels) |
| Landing pitch | `text-center text-sm md:text-lg sm:text-base` |
| Landing note | `text-xs leading-7 text-muted-foreground sm:text-sm sm:leading-8` |
| Offline / status line | `text-xs text-muted-foreground` |

Every clock is `font-mono tabular-nums` and `dir="ltr"` — Persian digits in a
right-to-left document still count left to right, and without `tabular-nums`
the digits jitter each tick.

## Numerals and dates

- **Persian digits everywhere** in user-facing output (`۲۵:۰۰`), via
  `faDigits`. Usernames are the exception — they render through `enDigits`
  and in `[font-family:ui-sans-serif,system-ui,sans-serif]`, since a handle is
  Latin.
- Countdown: `mm:ss`, zero-padded, `Math.ceil` on the remaining ms.
- Headline totals: bare `h:mm` (`۲:۲۵`); under an hour still reads as a clock
  (`۰:۴۵`).
- Sentence totals: «۲ ساعت و ۲۵ دقیقه» / «۴۵ دقیقه».
- Dates: Jalali via `Intl.DateTimeFormat("fa-IR-u-ca-persian")`, timezone
  `Asia/Tehran`, day-month-year order («۲ مرداد ۱۴۰۵»); chart ticks drop the
  year. A `YYYY-MM-DD` day key is resolved at `T12:00:00Z`, which is
  unambiguously inside the Tehran day.

## Buttons

Base:

```
group/button inline-flex shrink-0 items-center justify-center rounded-none
border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap
transition-all outline-none select-none
focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50
active:not-aria-[haspopup]:translate-y-px
disabled:pointer-events-none disabled:opacity-50
[&_svg]:pointer-events-none [&_svg]:shrink-0
[&_svg:not([class*='size-'])]:size-4
```

Note `active:translate-y-px` — the only motion a button has, and it is
suppressed on popover triggers.

**Variants**

| | |
| --- | --- |
| `default` | `bg-primary text-primary-foreground hover:bg-primary/80` |
| `outline` | `border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted` |
| `secondary` | `bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]` |
| `ghost` | `text-muted-foreground hover:bg-muted hover:text-foreground` |
| `destructive` | `bg-destructive/10 text-destructive hover:bg-destructive/20` |
| `link` | `text-primary underline-offset-4 hover:underline` |

**Sizes** — one notch larger than stock shadcn, because the stock scale reads
cramped with Persian text at a 112.5% root:

| | |
| --- | --- |
| `xs` | `h-7 gap-1 px-2.5 text-xs`, icons `size-3.5` |
| `sm` | `h-8 gap-1.5 px-3` |
| `default` | `h-10 gap-2 px-4` |
| `lg` | `h-11 gap-2 px-5 text-base` |
| `icon` | `size-10` |
| `icon-xs` / `icon-sm` / `icon-lg` | `size-7` / `size-8` / `size-11` |

**Fixed CTA boxes** (these exist to stop layout shift and must be kept):

- NavBar CTA: `h-8 min-w-24` — wide enough for the longer of «لاگین کن» and «پروفایل».
- Landing CTA: `h-11 w-40`, and the GitHub link beside it is forced to the same `h-11 w-40`.
- Start button: `w-40`. Ring confirm button: `w-56`.

## Alert

The one box used for anything the user must actually read — login failures,
the experimental notice, profanity refusals.

```
relative grid w-full gap-0.5 rounded-none border px-2.5 py-2 text-start text-sm
has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2
*:[svg]:row-span-2 *:[svg]:translate-y-0.5
*:[svg:not([class*='size-'])]:size-4
```

Title `font-medium`; description `text-sm text-muted-foreground text-balance`.
An **error** alert additionally takes `className="text-foreground"` on both
the alert and the description — that is the full-white treatment standing in
for the red it isn't allowed.

## Dialog

One inset for every dialog in the app, set on `DialogContent` rather than per
dialog so there is a single place it can drift from:

```
fixed top-1/2 start-1/2 z-50 grid w-full max-w-[calc(100%-2rem)]
-translate-x-1/2 rtl:translate-x-1/2 -translate-y-1/2
gap-4 rounded-none bg-popover p-6 text-sm ring-1 ring-foreground/10
duration-100 outline-none sm:max-w-lg sm:p-20
data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95
data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95
```

`p-6` on phones, `p-20` (5rem a side) above `sm` — on a 360px phone the airy
inset would leave ~150px of usable width. It widens to `max-w-lg` at the same
breakpoint for the same reason: `max-w-sm` would spend most of itself on
padding. Overlay: `bg-black/80 backdrop-blur-xs duration-100`.

Dialog footers bleed back out to the content edge and must track that padding
exactly: `-mx-6 -mb-6 … sm:-mx-20 sm:-mb-20`, horizontally only.

## Input

```
h-10 w-full min-w-0 rounded-none border border-input bg-transparent px-3 py-1
text-base transition-colors outline-none placeholder:text-muted-foreground
focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50
md:text-sm
```

`text-base` on mobile and `md:text-sm` above it is deliberate: iOS Safari zooms
the viewport on focus for anything under 16px.

## Switch

Off-grid pixel values, kept as-is: `h-[18.4px] w-[32px]` (default),
`h-[14px] w-[24px]` (sm), thumb `size-3` / `size-2.5`, square (`rounded-none`),
`data-checked:bg-primary data-unchecked:bg-input`. The thumb translates
`calc(100%-2px)`, negated under `rtl:`. The `after:-inset-x-3 after:-inset-y-2`
pseudo-element is the enlarged touch target.

## Skeleton

`animate-pulse rounded-md bg-muted` — note the component's own `rounded-md` is
a shadcn leftover, and every call site overrides it with `rounded-none`. In the
rewrite, put `rounded-none` in the component and drop the overrides.

## Timer screens

**Start screen** — a `grid w-full min-w-0` holding the category picker above a
bordered panel:

```
flex w-full min-w-0 flex-col items-center gap-6 border border-t-0
px-3 py-12 sm:px-10 sm:py-20
```

`border-t-0` because the picker above it supplies that edge. `px-3` on phones
is the constraint the `−/clock/+` row imposes, not a type decision — at the
desktop `px-10` that row alone is wider than a 360px frame. The stepper row is
`flex items-center gap-2 sm:gap-4` with `dir="ltr"`.

**Running** — `flex w-full flex-col items-center gap-6`, in order: task name
(`max-w-full truncate text-center text-muted-foreground`), clock, progress bar,
cycle dots, action button.

Progress bar: track `h-1 w-full max-w-xs bg-muted`, fill
`h-full bg-foreground transition-[width] duration-500 ease-linear`. It inherits
RTL so it fills from the right. Keyed by session id so a new session mounts at
0% rather than transitioning down from the previous one's finished fill, and
the width is clamped to `[0,100]` — a negative percentage is invalid CSS and
would fall back to `width:auto`, flashing a full white bar.

**Cycle dots** — `flex gap-2`, each `h-2 w-2 rounded-none`, filled
`bg-foreground` / empty `bg-muted`, count clamped to `perCycle`.

**Ring screen** — same column, but: `BellRing` at `size-8 animate-pulse` beside
the headline, and the clock counts **up** in `text-rose-500` prefixed with `+`.
Work offers one `w-56` outline confirm; a break offers a stacked
`continue` (outline, `lg`) over `done` (ghost) in a `max-w-xs` column.

## Landing

- Hero: `relative overflow-hidden aspect-video w-full shrink-0 mt-5`. The
  **wrapper owns the box**, not the image's intrinsic size — Turbopack can't
  decode AVIF, so the import yields a bare URL with no dimensions. Image is
  `object-cover`, `unoptimized`, preloaded as the LCP element.
- Scrim over it: `bg-linear-to-t from-background via-background/50 to-transparent`,
  `flex justify-center items-end px-6 pb-4`, `z-5`. The title sits in the
  bottom band, where the gradient is opaque enough for type to be legible
  whatever the image is doing.
- Body: `flex flex-col gap-8 px-6 pb-10 sm:gap-10`.
- The one hairline in the app: `h-0.5 bg-linear-to-r from-transparent via-border to-transparent`.

## Feed

`w-full rounded-none border border-border bg-card`, rows in a `divide-y
divide-border` list. Each row: `flex items-center justify-between gap-3 px-4
py-3 text-sm`. Username `truncate font-medium hover:underline`, separator
`" — "`, remaining time `shrink-0 font-mono tabular-nums text-muted-foreground`
with `dir="ltr"`. Breaks show no time.

**No heading above the box** — decided, not overlooked (#27). v1's SPEC asked
for one and v1 never built it, and the screenshots are what this rewrite
matches. The empty state *is* built, which looks like following SPEC on one
half of a sentence and the screenshots on the other; it is not. Each half
follows this file: the box carries no heading because the spec above describes
it without one, and it holds a row's height because of the rule under
Layout-shift rules below. There is no copy for a heading — do not
reintroduce one.

## Profile / day detail

- Chart area: `h-44 w-full`, `mt-4`.
- Day detail header: `flex items-stretch gap-4` — a text column
  (`flex min-w-0 flex-1 flex-col justify-center`) beside a square image
  (`relative aspect-square w-1/2 shrink-0 overflow-hidden sm:w-[60%]`) carrying
  its own top-to-bottom scrim (`from-background via-background/20 to-transparent`).
- Total: `mt-1 text-4xl leading-none font-bold sm:text-6xl`, Jalali date above
  it as `truncate text-xs text-muted-foreground`, caption below at
  `mt-1.5 text-base font-bold sm:text-lg`.
- Category rows: `mt-4 space-y-3`, each `flex items-baseline justify-between
  gap-3 text-xs` over a bar `mt-1.5 h-1 w-full bg-secondary` filled
  `h-full bg-chart-1`.
- Empty state: `mt-6 flex flex-col items-center gap-6 border p-12 text-center sm:p-20`.

## Motion

Deliberately almost none.

- Buttons: `active:translate-y-px`.
- Dialogs: `duration-100`, fade + `zoom-95`.
- Progress bar: `transition-[width] duration-500 ease-linear`.
- Ring: `animate-pulse` on the bell and on the NavBar badge.
- Skeletons: `animate-pulse`.
- Day-detail panel and chart day changes cross-fade; the outgoing panel
  finishes leaving before the incoming one arrives, because the two differ in
  height with the category list.

## Layout-shift rules

These are design decisions, not implementation details, and the rewrite must
honor them:

- Any control that depends on unresolved state **reserves its exact final
  box** rather than rendering nothing. Applies to the NavBar CTA, the landing
  CTA and today's focus.
- **Reserving space is not guessing content.** The placeholder never predicts
  which label wins, so shift is removed without reintroducing a flash of the
  wrong CTA.
- Sections that can be empty hold a row's height rather than vanishing.

## Assets that must survive the wipe

These cannot be regenerated and are content, not architecture:

- `app/fonts/PeydaFaNumWeb-*.woff2` — 10 weights.
- `public/banners/frieren-*.avif` — 26 images. They live at
  `client/src/assets/banners/` in the rewrite, and not in `client/public/`,
  because the day detail enumerates the folder at build time — dropping a file
  in is all it takes to add one, and nothing can enumerate `public/`.
- `public/main.avif` — the fixed hero.
- `public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`,
  `app/icon.svg`, `app/apple-icon.png`, `app/favicon.ico`.
- `lib/copy.json` — every word of Persian in the product.
- `lib/profanity.json` + `scripts/build-profanity.ts` — the generated wordlist
  and the script that is the actual source (words are added there, never in
  the JSON).
- The NavBar tomato is inline SVG, not a file: `viewBox="88 105 336 336"`,
  `stroke-width 26`, round caps and joins, `currentColor`, four paths (an
  ellipse plus three leaf/stem curves). Reproduced verbatim in the tokens
  above the fold of this doc's Buttons section — copy it out of
  `git show v1-nextjs:components/nav-bar.tsx`.
