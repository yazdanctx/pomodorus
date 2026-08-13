import { useEffect, useState } from "react";

import { faDigits } from "@/lib/format";

/**
 * Milestone 0's whole client: one round trip that proves the stack is wired —
 * browser → Vite proxy → Go → Postgres → back. It gets replaced by the real
 * routes in milestone 1 and is not a design surface, though it uses the app's
 * own type and palette so that a broken stylesheet is visible here too.
 */
type Health = {
  ok: boolean;
  serverNow: number;
  env: string;
  database: string;
  users: number;
};

type State =
  | { status: "loading" }
  | { status: "ready"; health: Health; skewMs: number }
  | { status: "error"; message: string };

export function App() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const requestedAt = Date.now();
    fetch("/api/health")
      .then(async (res) => {
        const health: Health = await res.json();
        // The measurement the whole timer will depend on: the device clock is
        // trusted to measure elapsed time and never to say what time it is.
        // Half the round trip is the crudest possible correction, and is
        // replaced by a proper estimate when the socket exists.
        const roundTrip = Date.now() - requestedAt;
        const skewMs = Date.now() - (health.serverNow + roundTrip / 2);
        setState({ status: "ready", health, skewMs });
      })
      .catch((error: unknown) => {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-light tracking-widest uppercase text-yellow-600">
        Pomodorus
      </h1>

      {state.status === "loading" && (
        <p className="text-sm text-muted-foreground">…</p>
      )}

      {state.status === "error" && (
        <div className="border border-border px-2.5 py-2 text-sm text-foreground">
          {state.message}
        </div>
      )}

      {state.status === "ready" && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Row label="سرور" value={state.health.ok ? "بالاست" : "پایینه"} />
          <Row label="دیتابیس" value={state.health.database} />
          <Row label="محیط" value={state.health.env} />
          <Row label="کاربرها" value={faDigits(state.health.users)} />
          <Row
            label="اختلاف ساعت"
            value={`${faDigits(Math.round(state.skewMs))} ms`}
          />
        </dl>
      )}
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums" dir="ltr">
        {value}
      </dd>
    </>
  );
}
