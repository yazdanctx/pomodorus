import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest is run without globals, so React Testing Library's own auto-cleanup
// never registers itself. Unmounting between tests is what stops one test's
// document from being queryable in the next.
afterEach(cleanup);
