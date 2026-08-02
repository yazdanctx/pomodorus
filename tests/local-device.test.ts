import test from "node:test";
import assert from "node:assert/strict";
import {
  apply,
  effectiveCategories,
  normalizeServerCategories,
  type Command,
  type Env,
} from "../lib/local/device";
import {
  EMPTY_STATE,
  FAST_MS,
  IDLE_RESET_MS,
  LONG_BREAK_MS,
  MINUTE_MS,
  SHORT_BREAK_MS,
  type LocalState,
} from "../lib/local/types";
import { copy } from "../lib/copy";

const T0 = 1_000_000_000_000;

/** A deterministic env: fixed clock, counted ids. */
function env(now: number): Env {
  let n = 0;
  return { now, newId: () => `id${++n}` };
}

/** Run one command at `now`, from `state`. */
const at = (now: number, state: LocalState, command: Command) =>
  apply(state, command, env(now));

/** A 25-minute work session started at T0, on category `cat1`. */
const working = (over: Partial<LocalState> = {}): LocalState => ({
  ...EMPTY_STATE,
  running: {
    id: "w1",
    kind: "work",
    categoryClientId: "cat1",
    startedAt: T0,
    durationMs: 25 * MINUTE_MS,
  },
  ...over,
});

const onBreak = (
  kind: "shortBreak" | "longBreak",
  over: Partial<LocalState> = {},
): LocalState => ({
  ...EMPTY_STATE,
  running: {
    id: "b1",
    kind,
    categoryClientId: null,
    startedAt: T0,
    durationMs: kind === "longBreak" ? LONG_BREAK_MS : SHORT_BREAK_MS,
  },
  ...over,
});

// ---- Starting work ----

test("starting work runs a session of the chosen length", () => {
  const { state, rejected } = at(T0, EMPTY_STATE, {
    type: "startWork",
    categoryClientId: "cat1",
    minutes: 55,
    fast: false,
  });
  assert.equal(rejected, undefined);
  assert.equal(state.running?.kind, "work");
  assert.equal(state.running?.durationMs, 55 * MINUTE_MS);
  assert.equal(state.running?.startedAt, T0);
  assert.equal(state.running?.categoryClientId, "cat1");
  assert.equal(state.running?.devFast, undefined);
});

test("only 25 and 55 minutes are work durations", () => {
  for (const minutes of [0, 1, 24, 26, 50, 90, -25, Number.NaN]) {
    const { state, rejected } = at(T0, EMPTY_STATE, {
      type: "startWork",
      categoryClientId: "cat1",
      minutes,
      fast: false,
    });
    assert.notEqual(rejected, undefined, `${minutes} should be rejected`);
    assert.equal(state.running, null);
  }
});

test("a fast session is credited at its nominal duration", () => {
  const { state } = at(T0, EMPTY_STATE, {
    type: "startWork",
    categoryClientId: "cat1",
    minutes: 25,
    fast: true,
  });
  assert.equal(state.running?.devFast, true);
  // Stored at 25 minutes, but really over after FAST_MS.
  assert.equal(state.running?.durationMs, 25 * MINUTE_MS);
  const { state: done } = at(T0 + FAST_MS, state, { type: "settle" });
  assert.equal(done.pendingSessions[0].durationMs, 25 * MINUTE_MS);
  assert.equal(done.pendingSessions[0].devFast, true);
});

test("a second session cannot start on top of a running one", () => {
  const { state, rejected } = at(T0 + MINUTE_MS, working(), {
    type: "startWork",
    categoryClientId: "cat2",
    minutes: 25,
    fast: false,
  });
  assert.notEqual(rejected, undefined);
  assert.equal(state.running?.id, "w1");
});

// ---- The cycle counter ----

test("the fourth completed session earns a long break", () => {
  const { state } = at(T0 + 25 * MINUTE_MS, working({ cycleCount: 3 }), {
    type: "settle",
  });
  assert.equal(state.cycleCount, 4);
  assert.equal(state.running?.kind, "longBreak");
  assert.equal(state.running?.durationMs, LONG_BREAK_MS);
});

test("earlier sessions earn a short break", () => {
  for (const cycleCount of [0, 1, 2]) {
    const { state } = at(T0 + 25 * MINUTE_MS, working({ cycleCount }), {
      type: "settle",
    });
    assert.equal(state.running?.kind, "shortBreak");
    assert.equal(state.running?.durationMs, SHORT_BREAK_MS);
    assert.equal(state.cycleCount, cycleCount + 1);
  }
});

test("the long break resets the cycle, taken or skipped", () => {
  const taken = at(T0 + LONG_BREAK_MS, onBreak("longBreak", { cycleCount: 4 }), {
    type: "settle",
  });
  assert.equal(taken.state.cycleCount, 0);

  const skipped = at(T0 + MINUTE_MS, onBreak("longBreak", { cycleCount: 4 }), {
    type: "skipBreak",
  });
  assert.equal(skipped.state.cycleCount, 0);
});

test("skipping a short break leaves the cycle where it was", () => {
  const { state } = at(T0 + MINUTE_MS, onBreak("shortBreak", { cycleCount: 2 }), {
    type: "skipBreak",
  });
  assert.equal(state.cycleCount, 2);
  assert.equal(state.running, null);
  assert.equal(state.lastActivityAt, T0 + MINUTE_MS);
});

test("an hour of idleness abandons the cycle on the way into the next session", () => {
  const idle: LocalState = { ...EMPTY_STATE, cycleCount: 3, lastActivityAt: T0 };
  const start = (now: number) =>
    at(now, idle, {
      type: "startWork",
      categoryClientId: "cat1",
      minutes: 25,
      fast: false,
    }).state.cycleCount;

  // Just inside the hour: the cycle survives.
  assert.equal(start(T0 + IDLE_RESET_MS), 3);
  // Past it: those sessions were never one cycle.
  assert.equal(start(T0 + IDLE_RESET_MS + 1), 0);
});

test("the idle hour runs from when the last break ended, not from the session", () => {
  // Work ran T0 → T0+25, its short break T0+25 → T0+30. Starting again at
  // T0+85 is 85 minutes after the session began but only 55 after the device
  // last did anything, so the cycle stands.
  const { state } = at(T0 + 85 * MINUTE_MS, working(), {
    type: "startWork",
    categoryClientId: "cat1",
    minutes: 25,
    fast: false,
  });
  assert.equal(state.lastActivityAt, T0 + 30 * MINUTE_MS);
  assert.equal(state.cycleCount, 1);
  assert.equal(state.running?.kind, "work");
});

// ---- Cancelling and skipping ----

test("cancelling a work session credits nothing and leaves the cycle alone", () => {
  const { state } = at(T0 + 10 * MINUTE_MS, working({ cycleCount: 2 }), {
    type: "cancelWork",
  });
  assert.equal(state.running, null);
  assert.deepEqual(state.pendingSessions, []);
  assert.equal(state.cycleCount, 2);
  // Nothing ended naturally, so nothing should chime.
  assert.equal(state.lastEnded, null);
});

test("there is nothing to cancel on a break, or when idle", () => {
  assert.notEqual(at(T0, EMPTY_STATE, { type: "cancelWork" }).rejected, undefined);
  assert.notEqual(
    at(T0 + MINUTE_MS, onBreak("shortBreak"), { type: "cancelWork" }).rejected,
    undefined,
  );
});

test("there is no break to skip during work, or when idle", () => {
  assert.notEqual(at(T0, EMPTY_STATE, { type: "skipBreak" }).rejected, undefined);
  assert.notEqual(at(T0 + MINUTE_MS, working(), { type: "skipBreak" }).rejected, undefined);
});

test("a cancel arriving after the end time still credits the session", () => {
  // The session was already over; cancelling cannot reach back and void it.
  const { state } = at(T0 + 30 * MINUTE_MS, working(), { type: "cancelWork" });
  assert.equal(state.pendingSessions.length, 1);
  assert.equal(state.pendingSessions[0].endedAt, T0 + 25 * MINUTE_MS);
});

// ---- Settling ----

test("a session mid-flight is left completely alone", () => {
  const state = working();
  // Same reference: nothing to persist, nothing to announce.
  assert.equal(at(T0 + 10 * MINUTE_MS, state, { type: "settle" }).state, state);
});

test("retroactive settle chain: work completes, break auto-runs, cycle counts", () => {
  const { state } = at(T0 + 60 * MINUTE_MS, working(), { type: "settle" });
  assert.equal(state.running, null);
  assert.equal(state.cycleCount, 1);
  assert.equal(state.pendingSessions.length, 1);
  // Credited at its real end time, not at the moment the app reopened.
  assert.equal(state.pendingSessions[0].endedAt, T0 + 25 * MINUTE_MS);
  assert.equal(state.pendingSessions[0].categoryClientId, "cat1");
  assert.equal(state.lastEnded?.kind, "shortBreak");
});

test("the break of a retroactively completed session starts at its end time", () => {
  // Reopened 28 minutes in: the work is over, its short break is still running —
  // and began when the work ended, not when the app came back.
  const { state } = at(T0 + 28 * MINUTE_MS, working(), { type: "settle" });
  assert.equal(state.running?.kind, "shortBreak");
  assert.equal(state.running?.startedAt, T0 + 25 * MINUTE_MS);
  // A minute later still and the break would be over too.
  assert.equal(
    at(T0 + 30 * MINUTE_MS, working(), { type: "settle" }).state.running,
    null,
  );
});

// ---- Categories ----

test("creating a category queues it and hands back its id", () => {
  const { state, created } = at(T0, EMPTY_STATE, {
    type: "createCategory",
    name: "  کد نویسی  ",
    isPublic: false,
  });
  assert.equal(created, "id1");
  assert.deepEqual(state.pendingCategoryOps, [
    { clientId: "id1", op: "upsert", name: "کد نویسی", isPublic: false, at: T0 },
  ]);
  assert.deepEqual(
    effectiveCategories(state).map((c) => c.name),
    ["کد نویسی"],
  );
});

test("a blank or overlong name is refused", () => {
  for (const name of ["", "   ", "ا".repeat(41)]) {
    const { state, created, rejected } = at(T0, EMPTY_STATE, {
      type: "createCategory",
      name,
      isPublic: true,
    });
    assert.equal(created, undefined);
    assert.notEqual(rejected, undefined);
    assert.deepEqual(state.pendingCategoryOps, []);
  }
  // Exactly at the limit is fine.
  assert.notEqual(
    at(T0, EMPTY_STATE, {
      type: "createCategory",
      name: "ا".repeat(40),
      isPublic: true,
    }).created,
    undefined,
  );
});

test("a profane name is refused, on the way in and on a rename", () => {
  const created = at(T0, EMPTY_STATE, {
    type: "createCategory",
    name: "سکس",
    isPublic: true,
  });
  assert.equal(created.created, undefined);
  assert.equal(created.rejected, copy.errors.categoryNameProfane);
  assert.deepEqual(created.state.pendingCategoryOps, []);

  // A clean category cannot be renamed into one either — which is the point of
  // checking here rather than only at creation.
  const state = at(T0, EMPTY_STATE, {
    type: "createCategory",
    name: "درس خوندن",
    isPublic: true,
  }).state;
  const renamed = at(T0 + 1, state, {
    type: "updateCategory",
    clientId: "id1",
    name: "کیری",
    isPublic: true,
  });
  assert.equal(renamed.rejected, copy.errors.categoryNameProfane);
  assert.equal(renamed.state.pendingCategoryOps[0].name, "درس خوندن");
});

test("a later edit replaces the queued one rather than stacking", () => {
  let state = at(T0, EMPTY_STATE, {
    type: "createCategory",
    name: "اول",
    isPublic: true,
  }).state;
  state = at(T0 + 1, state, {
    type: "updateCategory",
    clientId: "id1",
    name: "دوم",
    isPublic: false,
  }).state;
  assert.equal(state.pendingCategoryOps.length, 1);
  assert.equal(state.pendingCategoryOps[0].name, "دوم");
  assert.equal(state.pendingCategoryOps[0].isPublic, false);
});

test("a category cannot be edited out from under the session running on it", () => {
  const state = working(); // running on cat1
  for (const command of [
    { type: "updateCategory", clientId: "cat1", name: "تازه", isPublic: true },
    { type: "deleteCategory", clientId: "cat1" },
  ] as const) {
    const applied = at(T0 + MINUTE_MS, state, command);
    assert.notEqual(applied.rejected, undefined);
    assert.deepEqual(applied.state.pendingCategoryOps, []);
  }
  // A category the session is not on is fair game.
  assert.equal(
    at(T0 + MINUTE_MS, state, { type: "deleteCategory", clientId: "cat2" }).rejected,
    undefined,
  );
});

test("a category is editable again once its session is over", () => {
  // The session has ended, so the break — not the work — is what is running.
  const applied = at(T0 + 30 * MINUTE_MS, working(), {
    type: "deleteCategory",
    clientId: "cat1",
  });
  assert.equal(applied.rejected, undefined);
});

test("deleting hides a category the server still knows about", () => {
  const state: LocalState = {
    ...EMPTY_STATE,
    serverCategories: [{ clientId: "a", name: "یک", isPublic: true, updatedAt: 1 }],
  };
  const { state: next } = at(T0, state, { type: "deleteCategory", clientId: "a" });
  assert.deepEqual(effectiveCategories(next), []);
});

test("a newer server row wins over an older queued edit", () => {
  const state: LocalState = {
    ...EMPTY_STATE,
    serverCategories: [
      { clientId: "a", name: "سرور", isPublic: true, updatedAt: T0 + 10 },
    ],
    pendingCategoryOps: [
      { clientId: "a", op: "upsert", name: "قدیمی", isPublic: true, at: T0 },
    ],
  };
  assert.deepEqual(
    effectiveCategories(state).map((c) => c.name),
    ["سرور"],
  );
});

test("refreshing the server mirror with identical rows changes nothing", () => {
  const rows = [{ clientId: "a", name: "یک", isPublic: true, updatedAt: 1 }];
  const state: LocalState = { ...EMPTY_STATE, serverCategories: rows };
  // Same reference back: reconnect churn must not thrash storage.
  assert.equal(at(T0, state, { type: "setServerCategories", rows }).state, state);
});

// ---- Sync bookkeeping ----

test("marking synced clears exactly what was delivered", () => {
  const state: LocalState = {
    ...EMPTY_STATE,
    pendingSessions: [
      { clientId: "s1", startedAt: T0, durationMs: 25 * MINUTE_MS, endedAt: T0 + 1 },
      { clientId: "s2", startedAt: T0, durationMs: 25 * MINUTE_MS, endedAt: T0 + 2 },
    ],
    pendingCategoryOps: [
      { clientId: "a", op: "upsert", name: "یک", isPublic: true, at: T0 },
      // Edited again after the push went out: this one must survive.
      { clientId: "b", op: "upsert", name: "دو", isPublic: true, at: T0 + 5 },
    ],
  };
  const { state: next } = at(T0 + 10, state, {
    type: "markSynced",
    sessions: [state.pendingSessions[0]],
    ops: [
      state.pendingCategoryOps[0],
      // The version of "b" that was actually pushed, not the one queued since.
      { clientId: "b", op: "upsert", name: "دو", isPublic: true, at: T0 },
    ],
  });
  assert.deepEqual(
    next.pendingSessions.map((s) => s.clientId),
    ["s2"],
  );
  assert.deepEqual(
    next.pendingCategoryOps.map((o) => o.at),
    [T0 + 5],
  );
});

// ---- Reading the category cache ----

// Regression for the 2026-07-25 incident: the new client against a stale
// backend whose categories.list returned raw docs (no clientId). All rows
// collapsed onto the key `undefined` and the picker showed one category.
test("old-shape server rows never collapse the category list", () => {
  const oldShape = [
    { _id: "jx78kxwh", _creationTime: 1, userId: "u", name: "شطرنج", isPublic: true },
    { _id: "jx70h71v", _creationTime: 2, userId: "u", name: "کد نویسی", isPublic: true },
    { _id: "jx74fgq2", _creationTime: 3, userId: "u", name: "یادگیری", isPublic: true },
    { _id: "jx78h468", _creationTime: 4, userId: "u", name: "هانت", isPublic: true },
  ];
  const normalized = normalizeServerCategories(oldShape);
  assert.equal(normalized.length, 4);
  const visible = effectiveCategories({ ...EMPTY_STATE, serverCategories: normalized });
  assert.deepEqual(
    visible.map((c) => c.name).sort(),
    ["شطرنج", "هانت", "کد نویسی", "یادگیری"].sort(),
  );
});

test("a bad cache persisted by an old build is normalized on read too", () => {
  // effectiveCategories must survive state.serverCategories containing
  // un-normalized rows (written before normalizeServerCategories existed).
  const staleCache = [
    { _id: "a", name: "یک", isPublic: true },
    { _id: "b", name: "دو", isPublic: false },
  ] as never;
  const visible = effectiveCategories({ ...EMPTY_STATE, serverCategories: staleCache });
  assert.equal(visible.length, 2);
});

test("garbage rows are dropped, valid ones kept", () => {
  const rows = [
    null,
    42,
    { name: "بی‌کلید" }, // no clientId or _id
    { clientId: "ok", name: "درسته", isPublic: true, updatedAt: 5 },
  ];
  const normalized = normalizeServerCategories(rows);
  assert.deepEqual(normalized, [
    { clientId: "ok", name: "درسته", isPublic: true, updatedAt: 5 },
  ]);
});
