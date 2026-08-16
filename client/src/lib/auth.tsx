import {
  createContext,
  use,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { get, type ServerTimed } from "@/lib/api";

/**
 * Who the browser is, as far as the server is concerned.
 *
 * `authenticated` with a null handle is a real, ordinary state and not an
 * error: an account exists from the moment its email is verified, before its
 * owner has picked a handle. Such a user is signed in but appears nowhere
 * public, and every screen that leads somewhere public has to send them to
 * claim one first.
 */
export type Auth =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; handle: string | null };

export type AuthValue = Auth & {
  /** Re-ask the server. Called after signing in, out, or claiming a handle. */
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = use(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}

/**
 * Fetches the session once at mount and hands it down.
 *
 * `value` exists so a test can render a route at a chosen auth state without
 * standing up a fake server — the states worth testing are mostly the ones
 * that are awkward to reach, `loading` above all.
 */
export function AuthProvider({
  children,
  value,
}: {
  children: ReactNode;
  value?: AuthValue;
}) {
  const fetched = useFetchedAuth(value !== undefined);
  return <AuthContext value={value ?? fetched}>{children}</AuthContext>;
}

function useFetchedAuth(disabled: boolean): AuthValue {
  const [auth, setAuth] = useState<Auth>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const me = await get<ServerTimed & { handle: string | null }>("/api/me");
      setAuth({ status: "authenticated", handle: me.handle });
    } catch {
      // Not signed in, and a request that never arrived, resolve the same way:
      // neither says who you are, and the safe reading is the one that leaves
      // a way back in on screen.
      setAuth({ status: "anonymous" });
    }
  }, []);

  useEffect(() => {
    if (disabled) return;
    void refresh();
  }, [disabled, refresh]);

  return { ...auth, refresh };
}
