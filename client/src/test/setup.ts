import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom implements no layout, so it has no ResizeObserver. cmdk observes its
// list to keep the selected item in view — a behaviour that needs a viewport
// to mean anything, and that a test asserting on text does not exercise. A
// no-op is the honest stand-in.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Nor does it implement scrollIntoView, which cmdk calls for the same reason.
Element.prototype.scrollIntoView ??= () => {};

// Vitest is run without globals, so React Testing Library's own auto-cleanup
// never registers itself. Unmounting between tests is what stops one test's
// document from being queryable in the next.
afterEach(cleanup);

// Persisted preferences are per-device, and in a test run the device is shared
// by every test in the file. One test's remembered length must not become the
// next one's starting point.
afterEach(() => localStorage.clear());
