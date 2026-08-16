import { describe, expect, it } from "vitest";

import { BANNERS, createBannerAssignment } from "@/lib/banners";

const IMAGES = ["a.avif", "b.avif", "c.avif"];

// A fixed sequence of draws, so a case says what was picked rather than
// asserting around whatever chance did.
function drawing(...picks: number[]): () => number {
  let next = 0;
  return () => picks[next++ % picks.length] ?? 0;
}

describe("a visit's banner assignment", () => {
  it("keeps a day's picture for the rest of the visit", () => {
    const assignment = createBannerAssignment(IMAGES);

    const first = assignment.for("2026-03-15");
    // Pointing back and forth along the chart asks for the same day over and
    // over. Art that came back different every time would read as a glitch.
    expect(assignment.for("2026-03-15")).toBe(first);
    assignment.for("2026-03-14");
    expect(assignment.for("2026-03-15")).toBe(first);
  });

  it("gives consecutive days different pictures", () => {
    const assignment = createBannerAssignment(IMAGES);

    const drawn = ["a", "b", "c", "d", "e", "f", "g"].map((day) => assignment.for(day));
    for (let i = 1; i < drawn.length; i++) {
      expect(drawn[i]).not.toBe(drawn[i - 1]);
    }
  });

  it("shows every picture once before showing any of them twice", () => {
    const assignment = createBannerAssignment(IMAGES);

    const drawn = ["a", "b", "c"].map((day) => assignment.for(day));
    expect(new Set(drawn).size).toBe(IMAGES.length);
  });

  it("draws from the pool it was given", () => {
    // The first draw takes the middle image, the next the first of what is
    // left — the pool shrinks, so the same index means a different picture.
    const assignment = createBannerAssignment(IMAGES, drawing(0.5, 0));

    expect(assignment.for("a")).toBe("b.avif");
    expect(assignment.for("b")).toBe("a.avif");
  });

  it("repeats the only picture there is rather than running out", () => {
    const assignment = createBannerAssignment(["only.avif"]);

    expect(assignment.for("a")).toBe("only.avif");
    expect(assignment.for("b")).toBe("only.avif");
  });

  it("has nothing to show when there are no pictures", () => {
    expect(createBannerAssignment([]).for("a")).toBeNull();
  });
});

describe("the folder", () => {
  it("is enumerated at build time", () => {
    // Dropping a file into assets/banners is all it takes to add one, which is
    // the whole reason they are not in `public` — nothing can enumerate that.
    expect(BANNERS.length).toBeGreaterThan(0);
    expect(new Set(BANNERS).size).toBe(BANNERS.length);
  });
});
