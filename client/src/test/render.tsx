import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

import { AuthProvider, type Auth, type AuthValue } from "@/lib/auth";

/**
 * Render a piece of the app at a chosen route and a chosen auth state.
 *
 * Auth is injected rather than faked at `fetch` for the states that matter
 * here, because `loading` is the one that is hardest to hold still and the one
 * the layout-shift rules are actually about.
 */
export function renderAt(
  ui: ReactNode,
  { path = "/", auth = { status: "anonymous" } as Auth } = {},
) {
  const value: AuthValue = { ...auth, refresh: async () => {} };
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider value={value}>{ui}</AuthProvider>
    </MemoryRouter>,
  );
}
