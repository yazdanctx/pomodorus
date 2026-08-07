import test from "node:test";
import assert from "node:assert/strict";
import { createBannerAssignment } from "../lib/banners";

const BANNERS = ["/banners/a.avif", "/banners/b.avif", "/banners/c.avif"];

/** Draws in a fixed cycle, so each successive pick is predictable. */
const cycle = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

test("a day keeps the image it was first given", () => {
  const assignment = createBannerAssignment(BANNERS, cycle(0, 0.5, 0.999));
  const first = assignment.for("yazdan:2026-07-27");
  // Other days draw in between — the point is that coming back is stable.
  assignment.for("yazdan:2026-07-26");
  assignment.for("yazdan:2026-07-25");
  assert.equal(assignment.for("yazdan:2026-07-27"), first);
});

test("successive draws never repeat the previous image", () => {
  // Sweep the whole random range: no draw may land on the one before it.
  for (const r of [0, 0.34, 0.5, 0.67, 0.999]) {
    const assignment = createBannerAssignment(BANNERS, () => r);
    const drawn = ["a", "b", "c", "d"].map((k) => assignment.for(k));
    for (let i = 1; i < drawn.length; i++) {
      assert.notEqual(drawn[i], drawn[i - 1]);
    }
  }
});

test("every image stays reachable", () => {
  const assignment = createBannerAssignment(BANNERS, cycle(0, 0.999, 0.999));
  const seen = new Set(["a", "b", "c"].map((k) => assignment.for(k)));
  assert.equal(seen.size, 3);
});

test("two users are keyed apart", () => {
  const assignment = createBannerAssignment(BANNERS, cycle(0, 0.999));
  assert.notEqual(
    assignment.for("yazdan:2026-07-27"),
    assignment.for("someone:2026-07-27"),
  );
});

test("every image is used before any is used twice", () => {
  const assignment = createBannerAssignment(BANNERS);
  const drawn = ["a", "b", "c"].map((k) => assignment.for(k));
  assert.equal(new Set(drawn).size, BANNERS.length);
});

test("a reroll moves the day off the picture it was showing", () => {
  const assignment = createBannerAssignment(BANNERS);
  const before = assignment.for("yazdan:2026-07-27");
  assignment.reroll("yazdan:2026-07-27");
  const after = assignment.for("yazdan:2026-07-27");
  assert.notEqual(after, before);
  // And it sticks: the reroll is the new assignment, not a one-off read.
  assert.equal(assignment.for("yazdan:2026-07-27"), after);
});

test("a reroll tells subscribers", () => {
  const assignment = createBannerAssignment(BANNERS);
  let calls = 0;
  const unsubscribe = assignment.subscribe(() => {
    calls++;
  });
  assignment.reroll("yazdan:2026-07-27");
  assert.equal(calls, 1);
  unsubscribe();
  assignment.reroll("yazdan:2026-07-27");
  assert.equal(calls, 1);
});

test("a lone image repeats rather than vanishing", () => {
  const assignment = createBannerAssignment(["/banners/a.avif"]);
  assert.equal(assignment.for("a"), "/banners/a.avif");
  assert.equal(assignment.for("b"), "/banners/a.avif");
});

test("no images means no image", () => {
  const assignment = createBannerAssignment([]);
  assert.equal(assignment.for("a"), null);
});

test("a fresh visit draws its own sequence", () => {
  // Two assignments over the same list share no memory: this is what makes the
  // memo per-visit rather than per-process.
  const a = createBannerAssignment(BANNERS, cycle(0));
  const b = createBannerAssignment(BANNERS, cycle(0.999));
  assert.notEqual(a.for("yazdan:2026-07-27"), b.for("yazdan:2026-07-27"));
});
