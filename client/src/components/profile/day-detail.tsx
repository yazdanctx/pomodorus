import { useEffect } from "react";

import { copy } from "@/lib/copy";
import { faDate, faDuration, faHourClock } from "@/lib/format";
import { BANNERS, bannerAssignment } from "@/lib/banners";
import type { ChartDay, DayTask } from "@/lib/profile";

/**
 * One day's detail: the total set as a clock beside that day's picture, then
 * what the day was made of.
 *
 * Docked below the chart rather than floating at the cursor. A tooltip cannot
 * be read on a touch screen with a finger on top of it, cannot be pointed at
 * while it is read, and cannot be screenshotted — and this panel is the one
 * part of the page somebody sends to a friend.
 */
export function DayDetail({
  day,
  handle,
  owner,
}: {
  day: ChartDay;
  handle: string;
  owner: boolean;
}) {
  usePreloadedBanners();
  // Keyed by the person as well as the day, so following a link from one
  // profile to another does not hand them the same sequence — the art would
  // read as a property of the date rather than of the page.
  const banner = bannerAssignment().for(`${handle}:${day.day}`);

  return (
    <section className="mt-10">
      {/* A plain row already puts the first child on the right under dir=rtl,
          which is where the total belongs; the image trails on the left. */}
      <div className="flex items-stretch gap-4">
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <h3 className="truncate text-xs text-muted-foreground">{faDate(day.day)}</h3>
          {/* The unit sits under the clock rather than beside it: a bare h:mm
              says nothing about what was counted, and at this size there is no
              room alongside on a phone. */}
          <p className="mt-1 text-4xl leading-none font-bold sm:text-6xl" dir="ltr">
            {faHourClock(day.totalMs)}
          </p>
          {/* Set like the clock, not like a caption: the two read as one
              phrase, so the unit should not look like a footnote to it. */}
          <p className="mt-1.5 text-base font-bold sm:text-lg">{copy.profile.focusedHours}</p>
        </div>
        {/* Half the row on a phone, where the clock needs the space; from sm up
            the column is already at its width and the text has room to spare,
            so the image takes 60% and the text the remaining 40%. */}
        <div className="relative aspect-square w-1/2 shrink-0 overflow-hidden sm:w-[60%]">
          {/* The picture rises out of the page instead of sitting in a box on
              it — there are no boxes in this design, and no shadows to make
              one with. */}
          <div className="absolute inset-0 z-10 bg-linear-to-t from-background via-background/20 to-transparent" />
          {banner !== null && (
            <img src={banner} alt="" loading="eager" className="size-full object-cover" />
          )}
        </div>
      </div>

      <ul className="mt-4 space-y-3">
        {day.tasks.map((task) => (
          <li key={keyOf(task)}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              {/* A row with no name of its own is set quietly: it is a
                  placeholder standing in for one, not a task called that. */}
              <span className={`truncate ${task.name === null ? "text-muted-foreground" : ""}`}>
                {labelOf(task)}
              </span>
              <span className="shrink-0 text-muted-foreground">{faDuration(task.totalMs)}</span>
            </div>
            {/* The share of the day, which is what makes the rows comparable
                at a glance — the durations beside them are the exact answer. */}
            <div className="mt-1.5 h-1 w-full bg-secondary">
              <div
                className="h-full bg-chart-1"
                style={{ width: `${(task.totalMs / day.totalMs) * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>

      {/* Only on your own page, where the names are the real ones. Seeing your
          private tasks named is exactly the moment you might think everybody
          else can too. */}
      {owner && <p className="mt-4 text-xs text-muted-foreground">{copy.profile.ownerNote}</p>}
    </section>
  );
}

/** What a row is called: its own name, or the label its kind stands for. */
function labelOf(task: DayTask): string {
  if (task.name !== null) return task.name;
  return task.kind === "private" ? copy.profile.privateBucket : copy.profile.noTask;
}

/** Rows are unique by name within a day, and there is one of each nameless kind. */
function keyOf(task: DayTask): string {
  return task.name !== null ? `task:${task.name}` : task.kind;
}

/**
 * Warm every image up front.
 *
 * There are a few dozen and they are around ten kilobytes each, and pointing
 * along the chart walks through days one per mouse move — without this, each
 * first sighting would pop in and the scrub would read as stuttering.
 */
function usePreloadedBanners() {
  useEffect(() => {
    for (const src of BANNERS) {
      const image = new Image();
      image.src = src;
    }
  }, []);
}
