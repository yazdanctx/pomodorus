"use client";

import { Line, LineChart, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts";
import type { MouseHandlerDataParam } from "recharts/types/synchronisation/types";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { copy } from "@/lib/copy";
import { faDateShort } from "@/lib/format";

const config = {
  totalMs: { label: copy.profile.focusPerDay, color: "var(--chart-1)" },
} satisfies ChartConfig;

/**
 * The profile's focus chart: one minimal line of daily totals. Pointing at it
 * (mouse or touch drag) selects a day; the detail renders in the docked panel
 * below, never in a floating tooltip. The selected day is marked with a dot
 * and a faint crosshair so the panel always has a visible anchor.
 */
export function FocusChart({
  days,
  selectedKey,
  onSelect,
}: {
  days: { dayKey: string; totalMs: number }[];
  selectedKey?: string;
  onSelect: (dayKey: string) => void;
}) {
  const selected = days.find((d) => d.dayKey === selectedKey);
  const pick = (state: MouseHandlerDataParam) => {
    if (typeof state.activeLabel === "string") onSelect(state.activeLabel);
  };

  return (
    // Time still flows left-to-right on an RTL page.
    <div dir="ltr">
      <ChartContainer config={config} className="h-44 w-full">
        <LineChart
          data={days}
          margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
          onMouseMove={pick}
          onTouchStart={pick}
          onTouchMove={pick}
          onClick={pick}
        >
          {/* Tick size in rem, not px: SVG text ignores the cascade, so this
              keeps the axis on the same text-xs step as the day detail below
              and lets it track the root font-size. */}
          <XAxis
            dataKey="dayKey"
            tickFormatter={faDateShort}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={32}
            tick={{ fontSize: "0.75rem", fill: "var(--color-muted-foreground)" }}
          />
          <YAxis hide domain={[0, "auto"]} />
          {selected && (
            <ReferenceLine
              x={selected.dayKey}
              stroke="var(--color-muted-foreground)"
              strokeOpacity={0.4}
              strokeDasharray="3 3"
            />
          )}
          <Line
            type="monotone"
            dataKey="totalMs"
            stroke="var(--color-totalMs)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          {selected && (
            <ReferenceDot
              x={selected.dayKey}
              y={selected.totalMs}
              r={4}
              fill="var(--color-foreground)"
              stroke="var(--color-background)"
              strokeWidth={2}
            />
          )}
        </LineChart>
      </ChartContainer>
    </div>
  );
}
