"use client";

import { toSvg } from "html-to-image";
import { ImageDown, RefreshCw } from "lucide-react";
import Image from "next/image";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { bannerAssignment } from "@/lib/banners";
import { copy } from "@/lib/copy";
import type { FocusDay, FocusSlice } from "@/lib/focus-history";
import { faDate, faDuration, faHourClock } from "@/lib/format";

function sliceLabel(slice: FocusSlice): string {
  if (slice.name !== undefined) return slice.name;
  return slice.bucket === "private"
    ? copy.profile.privateBucket
    : copy.profile.noTask;
}

/**
 * The image for `key`, from the visit's banner assignment, and the way to draw
 * it again.
 *
 * The draw has to happen on the client — a cached server render would hand
 * every visitor the same sequence — so it goes through useSyncExternalStore:
 * null while rendering on the server and during hydration, the assigned image
 * immediately after. Subscribing is what makes `reroll` show up on screen.
 */
export function useBanner(
  banners: string[],
  key: string,
): { src: string | null; reroll: () => void } {
  const assignment = bannerAssignment(banners);
  const subscribe = useCallback(
    (onChange: () => void) => assignment.subscribe(onChange),
    [assignment],
  );
  const getSnapshot = useCallback(
    () => assignment.for(key),
    [assignment, key],
  );
  const src = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const reroll = useCallback(() => assignment.reroll(key), [assignment, key]);
  return { src, reroll };
}

/**
 * Warm every image up front. There are only a handful and they are tiny, and
 * pointing along the chart walks through days one per mouse move — without this
 * each first sighting would pop in and the scrub would read as stuttering.
 */
function usePreloadedBanners(banners: string[]) {
  useEffect(() => {
    for (const src of banners) {
      const img = new window.Image();
      img.src = src;
    }
  }, [banners]);
}

// Padding for the *downloaded* image only — applied to html-to-image's
// clone via `style`/`width`/`height`, which never touches the live node.
const CAPTURE_PAD_TOP = 64;
const CAPTURE_PAD_RIGHT = 64;
const CAPTURE_PAD_BOTTOM = 64;
const CAPTURE_PAD_LEFT = 64;

/**
 * Rasterizes html-to-image's SVG export at `pixelRatio`, without going
 * through `toPng`/`toCanvas`.
 *
 * Those scale up by drawing the (1x-sized) SVG into a larger canvas —
 * `ctx.drawImage(img, 0, 0, canvas.width, canvas.height)` with a canvas
 * bigger than the image's natural size. Chromium has a real bug there: an
 * SVG `<foreignObject>` drawn into a canvas at a size other than its own
 * gets its HTML content laid out as if scaled independently in each axis,
 * which is exactly the aspect-square-turns-portrait, bottom-cropped
 * distortion this component was shipping. Rewriting the SVG's own
 * `width`/`height` attributes to the scaled size (leaving `viewBox` at 1x)
 * and drawing it into a canvas that matches THAT size 1:1 sidesteps the
 * bug entirely — the browser rasterizes the foreignObject at the higher
 * resolution itself, so text and edges still come out sharp.
 */
async function svgToScaledPng(
  svgDataUrl: string,
  pixelRatio: number,
): Promise<string> {
  const svgText = decodeURIComponent(
    svgDataUrl.slice(svgDataUrl.indexOf(",") + 1),
  );
  const scaledSvgText = svgText.replace(
    /(<svg[^>]*?\swidth=")([\d.]+)("\s+height=")([\d.]+)(")/,
    (_match, pre: string, w: string, mid: string, h: string, post: string) =>
      `${pre}${Math.round(Number(w) * pixelRatio)}${mid}${Math.round(Number(h) * pixelRatio)}${post}`,
  );

  const img = new window.Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  const scaledDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(scaledSvgText)}`;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load rasterized SVG"));
    img.src = scaledDataUrl;
  });
  await img.decode();

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("2D canvas context unavailable");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

/**
 * One day's detail: the headline total beside that day's image, then the
 * per-category breakdown.
 */
export function DayCard({
  day,
  username,
  banners,
}: {
  day: FocusDay;
  username: string;
  banners: string[];
}) {
  usePreloadedBanners(banners);
  // Keyed by user, so navigating between two profiles doesn't hand them the
  // same sequence of images.
  const { src, reroll } = useBanner(banners, `${username}:${day.dayKey}`);

  const cardRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = useCallback(async () => {
    const node = cardRef.current;
    if (node === null || downloading) return;
    setDownloading(true);
    try {
      const svgDataUrl = await toSvg(node, {
        cacheBust: true,
        width: node.clientWidth + CAPTURE_PAD_LEFT + CAPTURE_PAD_RIGHT,
        height: node.clientHeight + CAPTURE_PAD_TOP + CAPTURE_PAD_BOTTOM,
        backgroundColor: "#000000",
        style: {
          boxSizing: "border-box",
          paddingTop: `${CAPTURE_PAD_TOP}px`,
          paddingRight: `${CAPTURE_PAD_RIGHT}px`,
          paddingBottom: `${CAPTURE_PAD_BOTTOM}px`,
          paddingLeft: `${CAPTURE_PAD_LEFT}px`,
        },
      });
      // 3x the card's on-screen size — the fonts and gradient edge need it,
      // or a phone-width capture comes out visibly soft.
      const dataUrl = await svgToScaledPng(svgDataUrl, 3);
      const link = document.createElement("a");
      link.download = `${username}-${day.dayKey}.png`;
      link.href = dataUrl;
      link.click();
    } catch {
      // Best-effort: nothing useful to recover on a failed capture.
    } finally {
      setDownloading(false);
    }
  }, [downloading, username, day.dayKey]);

  // No rule above the card: the gap alone separates it from the chart.
  return (
    <section className="mt-10">
      {/* Above the captured node rather than floating over the artwork, so the
          controls need no stacking context of their own — and being outside
          cardRef is what keeps them out of the screenshot, with no filtering.
          justify-end puts them at the physical left under dir=rtl, over the
          image they act on. icon-sm matches the dialog close button, the other
          icon-only control in the app. */}
      <div className="mb-2 flex justify-end gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={copy.profile.downloadAria}
              disabled={downloading}
              onClick={handleDownload}
            >
              <ImageDown />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {copy.profile.downloadAria}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={copy.profile.shuffleAria}
              onClick={reroll}
            >
              <RefreshCw />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {copy.profile.shuffleAria}
          </TooltipContent>
        </Tooltip>
      </div>
      {/*
        cardRef is the exact node html-to-image captures. It carries no
        classes of its own — it's a passthrough wrapper purely so the ref
        can target something that isn't the mt-10 section above it:
        html-to-image clones the ref'd node into a detached SVG
        foreignObject, where margin-collapsing no longer works the way it
        does in the live page — a margin-top here would push the content
        down inside a canvas still sized to the pre-margin height, silently
        cropping the bottom by about the margin's size. The capture's own
        padding (CAPTURE_PAD_*) is applied to html-to-image's clone via
        `style`, not to this node, so the live layout is untouched.
      */}
      <div ref={cardRef}>
        {/* A plain row already puts the first child on the right under dir=rtl,
            which is where the total belongs; the image trails on the left. */}
        <div className="flex items-stretch gap-4">
          <div className="flex min-w-0 flex-1 flex-col justify-center">
            <h3 className="truncate text-xs text-muted-foreground">
              {faDate(day.dayKey)}
            </h3>
            {/* The unit sits under the clock rather than beside it: a bare h:mm
                says nothing about what was counted, and at this size there is no
                room alongside on a phone. */}
            <p className="mt-1 text-4xl leading-none font-bold sm:text-6xl">
              {faHourClock(day.totalMs)}
            </p>
            {/* Set like the clock, not like a caption: the two read as one
                phrase, so the unit should not look like a footnote to it. */}
            <p className="mt-1.5 text-base font-bold sm:text-lg">
              {copy.profile.focusedHours}
            </p>
          </div>
          {/* Half the row on a phone, where the clock needs the space; from sm
              up the container is already at its max-w-xl and the text has room
              to spare, so the image takes 60% and the text the remaining 40%. */}
          <div className="relative aspect-square w-1/2 shrink-0 overflow-hidden sm:w-[60%]">
            <div className="absolute inset-0 z-10 bg-linear-to-t from-background via-background/20 to-transparent" />
            {src !== null && (
              <Image
                src={src}
                alt=""
                fill
                sizes="(max-width: 40rem) 50vw, 22rem"
                // The sources are already hand-optimised AVIF (~10 KB each);
                // running them through the optimiser would re-encode them to a
                // larger WebP.
                unoptimized
                className="object-cover"
              />
            )}
          </div>
        </div>
        <ul className="mt-4 space-y-3">
          {day.slices.map((slice) => (
            <li key={sliceLabel(slice)}>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span
                  className={`truncate ${
                    slice.name === undefined ? "text-muted-foreground" : ""
                  }`}
                >
                  {sliceLabel(slice)}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {faDuration(slice.ms)}
                </span>
              </div>
              <div className="mt-1.5 h-1 w-full bg-secondary">
                <div
                  className="h-full bg-chart-1"
                  style={{ width: `${(slice.ms / day.totalMs) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
