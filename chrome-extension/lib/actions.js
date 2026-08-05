// User-facing actions. Each one loads the current state, transitions it with
// the pure engine, persists it, and appends history when a work session
// actually completes (credited at the bell, not at confirm — see SPEC.md
// "ring time is not focus time").

import * as engine from "./engine.js";
import * as storage from "./storage.js";

export async function refresh() {
  const state = await storage.getState();
  const [next] = engine.tick(state, Date.now());
  if (next !== state) {
    if (next.phase === "work-ringing" && state.phase === "work-running") {
      await recordCompletion(next);
    }
    await storage.setState(next);
  }
  return next;
}

async function recordCompletion(state) {
  await storage.pushHistory({
    clientId: `${state.nominalEnd}-${state.categoryId ?? "none"}`,
    categoryId: state.categoryId,
    durationMinutes: state.workMinutes,
    completedAt: state.nominalEnd,
  });
}

export async function start({ categoryId, workMinutes }) {
  const state = await storage.getState();
  const settings = await storage.getSettings();
  const next = engine.startWork(state, settings, { categoryId, workMinutes });
  await storage.setState(next);
  return next;
}

export async function cancel() {
  const state = await storage.getState();
  const next = engine.cancelWork(state);
  await storage.setState(next);
  return next;
}

export async function skip() {
  const state = await storage.getState();
  const next = engine.skipBreak(state);
  await storage.setState(next);
  return next;
}

export async function confirmWork() {
  const state = await refresh();
  if (state.phase !== "work-ringing") return state;
  const next = engine.confirmWorkRing(state);
  await storage.setState(next);
  return next;
}

export async function confirmBreak(choice) {
  const state = await refresh();
  if (state.phase !== "break-ringing") return state;
  const next = engine.confirmBreakRing(state, choice);
  await storage.setState(next);
  return next;
}
