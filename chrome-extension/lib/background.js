// Service worker: keeps the timer honest while the popup is closed.
// The popup owns live, second-by-second rendering and its own WebAudio ding
// while it's open; this worker's job is the fallback path — flip a due
// session to "ringing", fire the one system notification, and keep the
// toolbar badge showing the countdown when nobody's looking.

import * as engine from "./engine.js";
import * as storage from "./storage.js";
import * as actions from "./actions.js";
import * as sync from "./sync.js";

const RING_ALARM = "pomodorus-ring";
const TICK_ALARM = "pomodorus-tick";
const SYNC_ALARM = "pomodorus-sync";

async function scheduleAlarms() {
  const state = await storage.getState();
  await chrome.alarms.clear(RING_ALARM);
  await chrome.alarms.clear(TICK_ALARM);

  if (state.phase === "work-running" || state.phase === "break-running") {
    chrome.alarms.create(RING_ALARM, { when: state.nominalEnd });
    chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  } else if (state.phase === "work-ringing" || state.phase === "break-ringing") {
    chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  }

  await updateBadge(state);
}

async function updateBadge(state) {
  const now = Date.now();
  if (state.phase === "work-running" || state.phase === "break-running") {
    const ms = engine.remainingMs(state, now);
    const minutes = Math.ceil(ms / 60000);
    await chrome.action.setBadgeText({ text: String(minutes) });
    await chrome.action.setBadgeBackgroundColor({ color: "#ffffff" });
    await chrome.action.setBadgeTextColor?.({ color: "#000000" });
  } else if (state.phase === "work-ringing" || state.phase === "break-ringing") {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#f43f5e" });
    await chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
  }
}

async function handleRing() {
  const before = await storage.getState();
  const next = await actions.refresh();
  if (next.phase === before.phase) return; // nothing crossed the line yet

  if (next.phase === "work-ringing") {
    await notify(
      "workDoneTitle",
      "تموم شد!",
      "برگرد تاییدش کن تا چیلت شروع شه"
    );
  } else if (next.phase === "break-ringing") {
    await notify("breakDoneTitle", "چیل تموم شد", "برگرد تا بریم یکی دیگه");
  }
  await scheduleAlarms();
}

async function notify(id, title, message) {
  await chrome.notifications.create(`pomodorus-${id}-${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title,
    message,
    requireInteraction: true,
    silent: false,
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === RING_ALARM) {
    await handleRing();
  } else if (alarm.name === TICK_ALARM) {
    const state = await storage.getState();
    await updateBadge(state);
    // A tick can also cross the finish line (e.g. worker was asleep).
    const before = state.phase;
    const next = await actions.refresh();
    if (next.phase !== before) await scheduleAlarms();
  }
});

chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_ALARM) {
    await sync.syncNow().catch(() => {});
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes["pomodorus.state"]) scheduleAlarms();
  if (changes["pomodorus.auth"] && changes["pomodorus.auth"].newValue) {
    sync
      .claimLocalDataOnSignIn()
      .then(() => sync.syncNow())
      .catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarms();
});
chrome.runtime.onStartup.addListener(() => {
  scheduleAlarms();
});

// Give the badge a value immediately when the worker wakes for any reason.
scheduleAlarms();
