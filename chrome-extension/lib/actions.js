// User-facing actions. Each one loads the current state, transitions it with
// the pure engine, persists it, and appends history when a work session
// actually completes (credited at the bell, not at confirm — see SPEC.md
// "ring time is not focus time").
//
// Presence + sync calls to the real backend are best-effort: they're
// advisory, not truth (SPEC.md), so any failure here is swallowed rather
// than surfaced — a network hiccup must never block the local timer.

import * as engine from "./engine.js";
import * as storage from "./storage.js";
import * as backend from "./backend.js";
import * as sync from "./sync.js";

async function safe(promise) {
  try {
    await promise;
  } catch {
    // advisory only — see file header
  }
}

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
  const clientId = `${state.nominalEnd}-${state.categoryId ?? "none"}`;
  await storage.pushHistory({
    clientId,
    categoryId: state.categoryId,
    durationMinutes: state.workMinutes,
    completedAt: state.nominalEnd,
  });
  if (await sync.isSignedIn()) {
    const categories = await storage.getCategories();
    const category = categories.find((c) => c.id === state.categoryId);
    await storage.queuePendingSession({
      clientId,
      categoryClientId: category ? category.id : undefined,
      startedAt: state.startedAt,
      durationMs: state.duration,
      endedAt: state.nominalEnd,
      devFast: false,
    });
    await safe(sync.syncNow());
  }
}

export async function start({ category, workMinutes }) {
  const state = await storage.getState();
  const settings = await storage.getSettings();
  const next = engine.startWork(state, settings, {
    categoryId: category?.id ?? null,
    workMinutes,
  });
  await storage.setState(next);
  if (await sync.isSignedIn()) {
    await safe(
      backend.setPresence({
        kind: "work",
        label: category && category.public ? category.name : null,
        startedAt: next.startedAt,
        durationMs: next.duration,
      })
    );
  }
  return next;
}

export async function cancel() {
  const state = await storage.getState();
  const next = engine.cancelWork(state);
  if (await sync.isSignedIn()) await safe(backend.clearPresence());
  await storage.setState(next);
  return next;
}

export async function skip() {
  const state = await storage.getState();
  const next = engine.skipBreak(state);
  if (await sync.isSignedIn()) await safe(backend.clearPresence());
  await storage.setState(next);
  return next;
}

export async function confirmWork() {
  const state = await refresh();
  if (state.phase !== "work-ringing") return state;
  const next = engine.confirmWorkRing(state);
  await storage.setState(next);
  if (await sync.isSignedIn()) {
    if (next.phase === "break-running") {
      const kind = next.breakKind === "long" ? "longBreak" : "shortBreak";
      await safe(
        backend.setPresence({
          kind,
          label: null,
          startedAt: next.startedAt,
          durationMs: next.duration,
        })
      );
    } else {
      await safe(backend.clearPresence());
    }
  }
  return next;
}

export async function confirmBreak(choice) {
  const state = await refresh();
  if (state.phase !== "break-ringing") return state;
  const next = engine.confirmBreakRing(state, choice);
  await storage.setState(next);
  if (await sync.isSignedIn()) {
    if (next.phase === "work-running") {
      const categories = await storage.getCategories();
      const category = categories.find((c) => c.id === next.categoryId);
      await safe(
        backend.setPresence({
          kind: "work",
          label: category && category.public ? category.name : null,
          startedAt: next.startedAt,
          durationMs: next.duration,
        })
      );
    } else {
      await safe(backend.clearPresence());
    }
  }
  return next;
}
