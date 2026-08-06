// Local-first sync, same shape as the web app's (docs/adr/0006): the device
// queues category ops and completed sessions locally, and drains the queue
// against the real server whenever it gets the chance. Nothing here is
// required for the timer to work — it's best-effort, fire-and-forget from
// the caller's point of view.

import * as storage from "./storage.js";
import * as backend from "./backend.js";

export async function isSignedIn() {
  const auth = await storage.getAuth();
  return !!auth?.token;
}

// Queues every not-yet-synced local category and history entry so a device
// that was used anonymously before signing in doesn't lose that work.
export async function claimLocalDataOnSignIn() {
  const categories = await storage.getCategories();
  const now = Date.now();
  for (const c of categories) {
    if (c.synced) continue;
    await storage.queueCategoryOp({
      clientId: c.id,
      op: "upsert",
      name: c.name,
      isPublic: !!c.public,
      at: c.updatedAt ?? now,
    });
  }
  const history = await storage.getHistory();
  for (const h of history) {
    if (h.synced) continue;
    await storage.queuePendingSession({
      clientId: h.clientId,
      categoryClientId: h.categoryId ?? undefined,
      startedAt: h.completedAt - h.durationMinutes * 60 * 1000,
      durationMs: h.durationMinutes * 60 * 1000,
      endedAt: h.completedAt,
      devFast: false,
    });
  }
}

export async function syncNow() {
  if (!(await isSignedIn())) return { skipped: true };

  const pendingOps = await storage.getPendingCategoryOps();
  const pendingSessions = await storage.getPendingSessions();

  if (pendingOps.length > 0 || pendingSessions.length > 0) {
    try {
      const ack = await backend.pushSync({
        categoryOps: pendingOps,
        sessions: pendingSessions,
      });
      const settledOpKeys = new Set(ack.categoryOps);
      const remainingOps = pendingOps.filter(
        (op) => !settledOpKeys.has(`${op.clientId}:${op.at}`)
      );
      await storage.setPendingCategoryOps(remainingOps);

      const settledSessionIds = new Set(ack.sessions);
      const remainingSessions = pendingSessions.filter(
        (s) => !settledSessionIds.has(s.clientId)
      );
      await storage.setPendingSessions(remainingSessions);

      // Mark local history rows settled so a later sign-out/sign-in cycle
      // doesn't requeue them.
      if (settledSessionIds.size > 0) {
        const history = await storage.getHistory();
        for (const h of history) {
          if (settledSessionIds.has(h.clientId)) h.synced = true;
        }
        await chrome.storage.local.set({ "pomodorus.history": history });
      }
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  try {
    const remoteCategories = await backend.fetchCategories();
    const local = await storage.getCategories();
    const localById = new Map(local.map((c) => [c.id, c]));
    const merged = remoteCategories.map((rc) => ({
      id: rc.clientId,
      name: rc.name,
      public: rc.isPublic,
      updatedAt: rc.updatedAt,
      synced: true,
      createdAt: localById.get(rc.clientId)?.createdAt ?? rc.updatedAt,
    }));
    await storage.setCategories(merged);
  } catch (err) {
    return { ok: false, error: err };
  }

  return { ok: true };
}
