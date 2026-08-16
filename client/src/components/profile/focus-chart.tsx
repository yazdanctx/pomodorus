import {
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";

import { faDateShort } from "@/lib/format";
import type { ChartDay } from "@/lib/profile";

/**
 * The profile's focus chart: one minimal line of daily totals.
 *
 * One series, so there is no legend — the section heading above it names the
 * line — and no floating tooltip. Pointing at the chart selects a day, and the
 * detail for it renders in the docked panel below rather than in something that
 * follows the cursor: a tooltip cannot be read on a touch screen while a finger
 * is on top of it, and it cannot be screenshotted.
 *
 * There is deliberately no shadcn `ChartContainer` under this. That component
 * exists to manage multi-series colour config and the tooltip machinery, and
 * this chart has one series in a fixed monochrome palette and no tooltip at
 * all — so the whole of what it would provide is one CSS variable.
 */
export function FocusChart({
  days,
  selected,
  onSelect,
}: {
  days: ChartDay[];
  /** The day the panel below is showing, marked here so it has an anchor. */
  selected?: string;
  onSelect?: (day: string) => void;
}) {
  const marked = days.find((day) => day.day === selected);

  // `activeLabel` is the x value under the pointer, which is the day key.
  const pick = (state: { activeLabel?: string | number }) => {
    if (onSelect && typeof state.activeLabel === "string") onSelect(state.activeLabel);
  };

  return (
    // Time still flows left to right on an RTL page: a chart that ran the
    // other way would put "today" where the eye looks for the oldest day.
    <div dir="ltr" className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={days}
          margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
          onMouseMove={pick}
          onTouchStart={pick}
          onTouchMove={pick}
          onClick={pick}
        >
          {/* Recessive: no tick marks, no axis rule, muted ink. The line is
              the content and the axis is the caption.

              Tick size in rem rather than px, because SVG text ignores the
              cascade — this keeps the axis on the same text-xs step as the
              rest of the page and lets it track the 106.25% root. */}
          <XAxis
            dataKey="day"
            tickFormatter={faDateShort}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={32}
            tick={{ fontSize: "0.75rem", fill: "var(--color-muted-foreground)" }}
          />
          {/* Hidden, but anchored at zero. A y-axis that started at the
              smallest value would make an ordinary week look like a collapse. */}
          <YAxis hide domain={[0, "auto"]} />

          {marked && (
            <ReferenceLine
              x={marked.day}
              stroke="var(--color-muted-foreground)"
              strokeOpacity={0.4}
              strokeDasharray="3 3"
            />
          )}

          <Line
            type="monotone"
            dataKey="totalMs"
            stroke="var(--color-chart-1)"
            strokeWidth={2}
            dot={false}
            // The data is a fact about the past; animating it in says something
            // is happening that is not.
            isAnimationActive={false}
          />

          {marked && (
            // A ring of the background colour around the dot, so it reads as a
            // marker on the line rather than a bump in it.
            <ReferenceDot
              x={marked.day}
              y={marked.totalMs}
              r={4}
              fill="var(--color-foreground)"
              stroke="var(--color-background)"
              strokeWidth={2}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
