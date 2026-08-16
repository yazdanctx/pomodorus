import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RequireHandle } from "@/components/require-handle";
import type { Auth } from "@/lib/auth";
import { copy } from "@/lib/copy";
import { ClaimHandleRoute } from "@/routes/claim-handle";
import { renderAt } from "@/test/render";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function serverAnswers(response: Response) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response)));
}

async function claim(handle: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(copy.handle.label), handle);
  await user.click(screen.getByRole("button", { name: copy.handle.claim }));
  return user;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("claiming a handle", () => {
  it("states the permanence before anything is confirmed", () => {
    renderAt(<ClaimHandleRoute />);

    expect(screen.getByText(copy.handle.permanentTitle)).toBeTruthy();
    expect(screen.getByText(copy.handle.permanent)).toBeTruthy();
  });

  it("shows the profile link the choice decides", async () => {
    renderAt(<ClaimHandleRoute />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(copy.handle.label), "yazdan");

    expect(screen.getByText("/u/yazdan", { exact: false })).toBeTruthy();
  });

  it("keeps the handle Latin and lowercase as it is typed", async () => {
    renderAt(<ClaimHandleRoute />);

    const user = userEvent.setup();
    const field = screen.getByLabelText(copy.handle.label);
    await user.type(field, "Yazdan۸۲");

    expect(field).toHaveProperty("value", "yazdan82");
  });

  it.each([
    ["handle_invalid", 400, () => copy.errors.usernameInvalid],
    ["handle_taken", 409, () => copy.errors.usernameTaken],
    ["handle_profane", 400, () => copy.errors.usernameProfane],
  ])("refuses %s with its own readable reason", async (code, status, message) => {
    serverAnswers(json(status, { error: code, serverNow: 0 }));
    renderAt(<ClaimHandleRoute />);

    await claim("yazdan");

    expect(await screen.findByText(message())).toBeTruthy();
    // Still on the step, with the field to correct.
    expect(screen.getByLabelText(copy.handle.label)).toBeTruthy();
  });

  it("offers a way out of a half-made account", () => {
    renderAt(<ClaimHandleRoute />);

    expect(
      screen.getByRole("button", { name: copy.handle.signOut }),
    ).toBeTruthy();
  });
});

describe("the gate in front of the timer", () => {
  function renderGate(auth: Auth) {
    return renderAt(
      <Routes>
        <Route
          path="/app"
          element={
            <RequireHandle>
              <p>the timer</p>
            </RequireHandle>
          }
        />
        <Route path="/login" element={<p>the login screen</p>} />
      </Routes>,
      { path: "/app", auth },
    );
  }

  it("sends a user with no handle to claim one rather than to the timer", () => {
    renderGate({ status: "authenticated", handle: null });

    expect(screen.getByText(copy.handle.title)).toBeTruthy();
    expect(screen.queryByText("the timer")).toBeNull();
  });

  it("lets a user with a handle through", () => {
    renderGate({ status: "authenticated", handle: "yazdan" });

    expect(screen.getByText("the timer")).toBeTruthy();
  });

  it("sends a signed-out visitor to sign in", () => {
    renderGate({ status: "anonymous" });

    expect(screen.getByText("the login screen")).toBeTruthy();
  });

  it("reserves the page rather than guessing while auth is unresolved", () => {
    renderGate({ status: "loading" });

    expect(screen.queryByText("the timer")).toBeNull();
    expect(screen.queryByText(copy.handle.title)).toBeNull();
    expect(screen.queryByText("the login screen")).toBeNull();
  });
});
