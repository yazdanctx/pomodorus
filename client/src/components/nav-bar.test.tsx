import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { NavBar } from "@/components/nav-bar";
import { copy } from "@/lib/copy";
import { faClock, faElapsed } from "@/lib/format";
import { noteServerTime } from "@/lib/server-clock";
import { holding, renderAt, SIGNED_IN, workSession } from "@/test/render";

/** The box the CTA and its placeholder must agree on, per the design tokens. */
const CTA_BOX = ["h-8", "min-w-24"];

function classesOf(el: Element): string[] {
  return el.className.split(/\s+/);
}

describe("NavBar", () => {
  it("keeps its own height whatever the auth state", () => {
    for (const auth of [
      { status: "loading" } as const,
      { status: "anonymous" } as const,
      { status: "authenticated", handle: "yazdan" } as const,
    ]) {
      const { unmount } = renderAt(<NavBar />, { auth });
      expect(classesOf(screen.getByRole("banner"))).toContain("h-14");
      unmount();
    }
  });

  describe("the reserved-box rule", () => {
    it("reserves the CTA's exact box while auth is unresolved", () => {
      renderAt(<NavBar />, { auth: { status: "loading" } });

      const placeholder = screen.getByTestId("nav-cta-placeholder");
      expect(classesOf(placeholder)).toEqual(expect.arrayContaining(CTA_BOX));
    });

    it("reserves space without predicting which label wins", () => {
      renderAt(<NavBar />, { auth: { status: "loading" } });

      // Neither CTA may be on screen yet — guessing is what flashed the wrong
      // one, and a placeholder that guesses has not solved anything.
      expect(screen.queryByText(copy.landing.enter)).toBeNull();
      expect(screen.queryByText(copy.header.myProfile)).toBeNull();
    });

    it("hands the resolved CTA the same box the placeholder held", () => {
      renderAt(<NavBar />, { auth: { status: "anonymous" } });

      const cta = screen.getByRole("link", { name: copy.landing.enter });
      expect(classesOf(cta)).toEqual(expect.arrayContaining(CTA_BOX));
    });
  });

  describe("the auth CTA", () => {
    it("offers a way in when signed out", () => {
      renderAt(<NavBar />, { auth: { status: "anonymous" } });

      expect(
        screen.getByRole("link", { name: copy.landing.enter }),
      ).toHaveProperty("pathname", "/login");
    });

    it("links to the profile once a handle is claimed", () => {
      renderAt(<NavBar />, {
        auth: { status: "authenticated", handle: "yazdan" },
      });

      expect(
        screen.getByRole("link", { name: copy.header.myProfile }),
      ).toHaveProperty("pathname", "/u/yazdan");
    });

    it("sends a user who has not claimed a handle back to the app", () => {
      renderAt(<NavBar />, {
        auth: { status: "authenticated", handle: null },
      });

      // Two links now read «تایمر»; the CTA is the one carrying the fixed box.
      const cta = screen
        .getAllByRole("link", { name: copy.header.timer })
        .find((link) => classesOf(link).includes("min-w-24"));
      expect(cta).toHaveProperty("pathname", "/app");
    });
  });

  it.each(["/login", "/offline"])("is hidden on %s", (path) => {
    renderAt(<NavBar />, { path });

    expect(screen.queryByRole("banner")).toBeNull();
  });

  describe("the timer badge", () => {
    const NOW = 1_800_000_000_000;

    beforeEach(() => noteServerTime(NOW, performance.now()));

    it("offers the plain way in when nothing is live", () => {
      renderAt(<NavBar />, { auth: SIGNED_IN, session: holding(null) });

      expect(screen.getByText(copy.header.timer)).toBeTruthy();
    });

    it("reserves the box rather than guessing while the answer is on its way", () => {
      // A mid-pomodoro reload must not flash «تایمر» and swap to a countdown a
      // beat later: unknown is not the same as idle.
      renderAt(<NavBar />, { auth: SIGNED_IN, session: holding(undefined) });

      const placeholder = screen.getByTestId("nav-timer-placeholder");
      expect(classesOf(placeholder)).toEqual(expect.arrayContaining(CTA_BOX));
      expect(screen.queryByText(copy.header.timer)).toBeNull();
    });

    it("swaps the label for the countdown while a session runs", () => {
      renderAt(<NavBar />, {
        auth: SIGNED_IN,
        session: holding(workSession(NOW + 5 * 60_000)),
      });

      expect(screen.getByText(faClock(5 * 60_000))).toBeTruthy();
      expect(screen.queryByText(copy.header.timer)).toBeNull();
    });

    it("inverts to the ring time, and is the only red in the bar", () => {
      renderAt(<NavBar />, {
        auth: SIGNED_IN,
        session: holding(workSession(NOW - 65_000)),
      });

      // Counting up is the opposite of what this badge otherwise means, so
      // the inversion has to be legible at a glance, not just in the digits.
      const badge = screen.getByText(faElapsed(65_000));
      const link = badge.closest("a");
      expect(link).not.toBeNull();
      expect(classesOf(link as Element)).toEqual(
        expect.arrayContaining(["text-rose-500", "animate-pulse"]),
      );
    });
  });
});
