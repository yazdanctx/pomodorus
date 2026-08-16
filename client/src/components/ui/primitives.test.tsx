import { render, screen } from "@testing-library/react";
import { TriangleAlert } from "lucide-react";
import { describe, expect, it } from "vitest";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button-variants";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

/**
 * The design is fixed and the values come from `docs/design-tokens.md`, so
 * these read the recorded measurements back off the rendered element. There is
 * no pixel diffing here — `docs/reference/` is for eyes — but the rules that
 * are easiest to break silently (a stray radius, a shadow, a size drifting a
 * notch back toward stock shadcn) are worth holding still.
 */

function classesOf(el: Element): string[] {
  return el.className.split(/\s+/);
}

describe("Button", () => {
  it.each([
    ["default", "h-10"],
    ["xs", "h-7"],
    ["sm", "h-8"],
    ["lg", "h-11"],
  ] as const)("sizes %s to %s", (size, height) => {
    render(<Button size={size}>برو</Button>);
    expect(classesOf(screen.getByRole("button"))).toContain(height);
  });

  it.each([
    ["icon", "size-10"],
    ["icon-xs", "size-7"],
    ["icon-sm", "size-8"],
    ["icon-lg", "size-11"],
  ] as const)("makes %s a %s square", (size, box) => {
    render(<Button size={size} aria-label="آیکن" />);
    expect(classesOf(screen.getByRole("button"))).toContain(box);
  });

  it.each([
    ["default", "bg-primary"],
    ["outline", "border-border"],
    ["secondary", "bg-secondary"],
    ["ghost", "text-muted-foreground"],
    ["destructive", "bg-destructive/10"],
    ["link", "underline-offset-4"],
  ] as const)("gives %s its own treatment", (variant, marker) => {
    render(<Button variant={variant}>برو</Button>);
    expect(classesOf(screen.getByRole("button"))).toContain(marker);
  });

  it("depresses by one pixel when pressed, and only when not a popover trigger", () => {
    render(<Button>برو</Button>);
    expect(classesOf(screen.getByRole("button"))).toContain(
      "active:not-aria-[haspopup]:translate-y-px",
    );
  });

  it("keeps every corner square and casts no shadow", () => {
    for (const variant of [
      "default",
      "outline",
      "secondary",
      "ghost",
      "destructive",
      "link",
    ] as const) {
      const classes = buttonVariants({ variant }).split(/\s+/);
      expect(classes).toContain("rounded-none");
      expect(classes.some((c) => c.startsWith("shadow"))).toBe(false);
    }
  });

  it("becomes whatever it wraps when asked to", () => {
    render(
      <Button asChild>
        <a href="/app">تایمر</a>
      </Button>,
    );
    expect(classesOf(screen.getByRole("link"))).toContain("h-10");
  });
});

describe("Alert", () => {
  it("renders an error in full white rather than in a hue it is not allowed", () => {
    render(
      <Alert className="text-foreground">
        <TriangleAlert />
        <AlertTitle>یه چیزی خراب شد</AlertTitle>
        <AlertDescription className="text-foreground">
          دوباره امتحان کن
        </AlertDescription>
      </Alert>,
    );

    const alert = screen.getByRole("alert");
    expect(classesOf(alert)).toContain("text-foreground");
    // The icon is what carries the error, since colour cannot.
    expect(alert.querySelector("svg")).toBeTruthy();
    expect(classesOf(alert)).toContain("rounded-none");
  });
});

describe("Skeleton", () => {
  it("is square, not rounded", () => {
    render(<Skeleton data-testid="s" className="h-8 w-24" />);
    const skeleton = screen.getByTestId("s");
    expect(classesOf(skeleton)).toContain("rounded-none");
    expect(classesOf(skeleton)).toContain("animate-pulse");
  });
});

describe("Input", () => {
  it("sets its text at 16px on phones so iOS Safari does not zoom on focus", () => {
    render(<Input aria-label="ایمیل" />);
    const classes = classesOf(screen.getByLabelText("ایمیل"));
    expect(classes).toContain("text-base");
    expect(classes).toContain("md:text-sm");
  });
});

describe("Switch", () => {
  it("carries the enlarged touch target the visible box does not", () => {
    render(<Switch aria-label="پابلیک" />);
    const classes = classesOf(screen.getByRole("switch"));
    expect(classes).toContain("after:-inset-x-3");
    expect(classes).toContain("after:-inset-y-2");
    expect(classes).toContain("data-[size=default]:h-[18.4px]");
  });
});

describe("Dialog", () => {
  it("uses the one shared inset: p-6 on phones, p-20 and max-w-lg above sm", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>تنظیم تایمرها</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const classes = classesOf(screen.getByRole("dialog"));
    expect(classes).toEqual(
      expect.arrayContaining(["p-6", "sm:p-20", "sm:max-w-lg", "rounded-none"]),
    );
  });
});
