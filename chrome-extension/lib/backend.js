// Talks to the real Pomodorus production Convex deployment — same backend
// the web app uses. Auth follows the wire protocol @convex-dev/auth's React
// client uses under the hood (see node_modules/@convex-dev/auth/dist/react/
// client.js + index.js): the "auth:signIn" action for both password sign-in
// and refresh-token exchange, called over plain HTTP (no websocket needed,
// which suits a popup that's only alive for seconds at a time).

import { ConvexHttpClient } from "./vendor/convex.bundle.js";
import * as storage from "./storage.js";

export const CONVEX_URL = "https://tacit-clam-994.convex.cloud";

function decodeJwtExpiry(token) {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const { exp } = JSON.parse(json);
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function client() {
  return new ConvexHttpClient(CONVEX_URL, { skipConvexDeploymentUrlCheck: true });
}

export function describeError(err) {
  if (err && typeof err.data === "string") return err.data;
  if (err && err.data && typeof err.data.message === "string") return err.data.message;
  if (err instanceof Error) return err.message;
  return "یه چیزی از سمت سرور خراب شد";
}

async function refresh(refreshToken) {
  const c = client();
  const result = await c.action("auth:signIn", { refreshToken });
  return result?.tokens ?? null;
}

// Returns a fresh, valid access token, refreshing it first if it's within a
// minute of expiring (or already expired). Null if signed out or refresh
// fails (e.g. the refresh token itself was revoked by a sign-out elsewhere).
export async function ensureFreshToken() {
  const auth = await storage.getAuth();
  if (!auth?.token) return null;
  const expiresAt = decodeJwtExpiry(auth.token);
  const soon = Date.now() > (expiresAt ?? 0) - 60_000;
  if (!soon) return auth.token;
  if (!auth.refreshToken) return null;
  try {
    const tokens = await refresh(auth.refreshToken);
    if (!tokens) {
      await storage.clearAuth();
      return null;
    }
    await storage.setAuth({ ...auth, token: tokens.token, refreshToken: tokens.refreshToken });
    return tokens.token;
  } catch {
    await storage.clearAuth();
    return null;
  }
}

async function authedClient() {
  const token = await ensureFreshToken();
  if (!token) throw new Error("signed out");
  const c = client();
  c.setAuth(token);
  return c;
}

// One flow, not two: an unknown username creates the account, a known one
// signs in, a known one with the wrong password is the only failure — the
// server decides which, exactly like the web app's /login.
export async function signIn(username, password) {
  const c = client();
  const result = await c.action("auth:signIn", {
    provider: "password",
    params: { username: username.trim().toLowerCase(), password },
  });
  if (!result?.tokens) throw new Error("لاگین انجام نشد");
  const { token, refreshToken } = result.tokens;
  await storage.setAuth({ token, refreshToken, username: username.trim().toLowerCase() });
  return true;
}

export async function signOut() {
  try {
    const c = await authedClient();
    await c.action("auth:signOut", {});
  } catch {
    // Already signed out server-side, or offline — clear locally regardless.
  }
  await storage.clearAuth();
}

export async function fetchCategories() {
  const c = await authedClient();
  return c.query("categories:list", {});
}

export async function pushSync({ categoryOps, sessions }) {
  const c = await authedClient();
  return c.mutation("sync:push", { categoryOps, sessions });
}

export async function setPresence({ kind, label, startedAt, durationMs }) {
  const c = await authedClient();
  return c.mutation("sessions:setPresence", { kind, label, startedAt, durationMs });
}

export async function clearPresence() {
  const c = await authedClient();
  return c.mutation("sessions:clearPresence", {});
}

// Public — works signed out too, `isMe` will just always be false.
export async function activeFeed() {
  const c = client();
  const token = await ensureFreshToken();
  if (token) c.setAuth(token);
  return c.query("sessions:activeFeed", {});
}

export async function todayFocusRemote() {
  const c = await authedClient();
  return c.query("sessions:todayFocus", {});
}

export async function profileChart(username, days) {
  const c = client();
  const token = await ensureFreshToken();
  if (token) c.setAuth(token);
  return c.query("profiles:chart", { username, days });
}

export async function whoAmI() {
  const c = await authedClient();
  return c.query("profiles:me", {});
}
