import { describe, expect, it } from "vitest";

import { copy } from "@/lib/copy";
import { manifest, manifestJSON } from "@/manifest";

describe("the web app manifest", () => {
  it("opens the installed app at the timer, in its own black window", () => {
    expect(manifest.start_url).toBe("/app");
    expect(manifest.display).toBe("standalone");
    expect(manifest.background_color).toBe("#000000");
    expect(manifest.theme_color).toBe("#000000");
  });

  it("names the app out of the one file the app's words live in", () => {
    expect(manifest.name).toBe(copy.app.name);
    expect(manifest.short_name).toBe(copy.app.name);
    expect(manifest.description).toBe(copy.app.description);
  });

  it("carries both installable sizes and a maskable one", () => {
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");

    const maskable = manifest.icons.filter(
      (icon) => "purpose" in icon && icon.purpose === "maskable",
    );
    expect(maskable).toHaveLength(1);
    expect(maskable[0]?.sizes).toBe("512x512");
  });

  it("is served as JSON somebody can read", () => {
    expect(JSON.parse(manifestJSON)).toEqual(manifest);
  });
});
