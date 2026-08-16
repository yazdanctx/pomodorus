import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { copy } from "@/lib/copy";
import { LoginRoute } from "@/routes/login";
import { renderAt } from "@/test/render";

/**
 * The seam is `fetch`, never a component's internals: feed the route server
 * payloads and assert what is on screen.
 */
function server(handlers: Record<string, () => Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      const handler = handlers[String(input)];
      if (!handler) throw new Error(`unstubbed request: ${input}`);
      return Promise.resolve(handler());
    }),
  );
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const ok = () => json(200, { sent: true, serverNow: 0 });
const failure = (status: number, error: string) => () =>
  json(status, { error, serverNow: 0 });

beforeEach(() => {
  vi.unstubAllGlobals();
});

async function submitEmail(address = "yazdan@example.com") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(copy.login.email), address);
  await user.click(screen.getByRole("button", { name: copy.login.sendCode }));
  return user;
}

describe("the login screen", () => {
  it("asks for an address and nothing else — there is no password anywhere", () => {
    renderAt(<LoginRoute />, { path: "/login" });

    expect(screen.getByLabelText(copy.login.email)).toBeTruthy();
    expect(screen.queryByLabelText(/پسورد/)).toBeNull();
  });

  it("stands the experimental notice and the no-password notice above the form", () => {
    renderAt(<LoginRoute />, { path: "/login" });

    expect(screen.getByText(copy.landing.experimentalTitle)).toBeTruthy();
    expect(screen.getByText(copy.login.otpTitle)).toBeTruthy();
  });

  it("leads somewhere back, so a signed-out visitor is not stranded", () => {
    renderAt(<LoginRoute />, { path: "/login" });

    expect(
      screen.getByRole("link", { name: copy.login.backHome }),
    ).toHaveProperty("pathname", "/");
  });

  it("moves to the code step once the address is sent", async () => {
    server({ "/api/auth/request-code": ok });
    renderAt(<LoginRoute />, { path: "/login" });

    await submitEmail();

    expect(await screen.findByLabelText(copy.login.code)).toBeTruthy();
    // The address is repeated back, because a typo is invisible otherwise.
    expect(screen.getByText(/yazdan@example\.com/)).toBeTruthy();
  });

  it("shows a spinner and a waiting label while it submits", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await held;
        return ok();
      }),
    );
    renderAt(<LoginRoute />, { path: "/login" });

    await submitEmail();

    const button = await screen.findByRole("button", {
      name: copy.login.sending,
    });
    expect(button.getAttribute("disabled")).not.toBeNull();
    expect(button.querySelector(".animate-spin")).toBeTruthy();

    release?.();
  });

  it("renders a refusal in the bordered white alert, in a live region", async () => {
    server({ "/api/auth/request-code": failure(400, "invalid_email") });
    renderAt(<LoginRoute />, { path: "/login" });

    // A domain with no dot: the browser lets it through and the server does
    // not, which is the only way to reach this path from the real form.
    await submitEmail("yazdan@localhost");

    const message = await screen.findByText(copy.login.invalidEmail);
    const box = message.closest('[role="alert"]');
    // Full white and iconned, because the palette does not allow it to be red.
    expect(box?.className).toContain("text-foreground");
    expect(box?.querySelector("svg")).toBeTruthy();
    // Announced, since it appears well below the field that caused it.
    expect(box?.closest("[aria-live]")).toBeTruthy();
  });

  it("says plainly when too many codes have been asked for", async () => {
    server({ "/api/auth/request-code": failure(429, "rate_limited") });
    renderAt(<LoginRoute />, { path: "/login" });

    await submitEmail();

    expect(await screen.findByText(copy.login.rateLimited)).toBeTruthy();
  });

  it("stays on the code step and explains when the code is wrong", async () => {
    server({
      "/api/auth/request-code": ok,
      "/api/auth/verify": failure(401, "bad_code"),
    });
    renderAt(<LoginRoute />, { path: "/login" });

    const user = await submitEmail();
    await user.type(await screen.findByLabelText(copy.login.code), "000000");
    await user.click(screen.getByRole("button", { name: copy.login.go }));

    expect(await screen.findByText(copy.login.badCode)).toBeTruthy();
    expect(screen.getByLabelText(copy.login.code)).toBeTruthy();
  });

  it("does not dress a network failure up as a wrong code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    renderAt(<LoginRoute />, { path: "/login" });

    await submitEmail();

    expect(await screen.findByText(copy.offline.needInternet)).toBeTruthy();
  });

  it("lets a wrong address be corrected without a reload", async () => {
    server({ "/api/auth/request-code": ok });
    renderAt(<LoginRoute />, { path: "/login" });

    const user = await submitEmail();
    await user.click(
      await screen.findByRole("button", { name: copy.login.changeEmail }),
    );

    expect(screen.getByLabelText(copy.login.email)).toBeTruthy();
  });

  it("can ask for another code when the first does not arrive", async () => {
    const fetched = vi.fn(() => Promise.resolve(ok()));
    vi.stubGlobal("fetch", fetched);
    renderAt(<LoginRoute />, { path: "/login" });

    const user = await submitEmail();
    await user.type(await screen.findByLabelText(copy.login.code), "12");
    await user.click(screen.getByRole("button", { name: copy.login.resend }));

    await waitFor(() => expect(fetched).toHaveBeenCalledTimes(2));
    // Anything half-typed is now a code that no longer exists.
    expect(screen.getByLabelText(copy.login.code)).toHaveProperty("value", "");
  });

  it("keeps the code in ASCII digits, since it is typed rather than read", async () => {
    server({ "/api/auth/request-code": ok });
    renderAt(<LoginRoute />, { path: "/login" });

    const user = await submitEmail();
    const field = await screen.findByLabelText(copy.login.code);
    await user.type(field, "۱۲۳۴۵۶");

    expect(field).toHaveProperty("value", "123456");
  });
});
