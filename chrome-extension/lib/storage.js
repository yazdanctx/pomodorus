// Thin chrome.storage.local wrapper — everything lives on the device, nothing
// is synced to any server. Categories are local-only in this extension build.

import { DEFAULT_SETTINGS, clampSettings, initialState } from "./engine.js";

const KEYS = {
  state: "pomodorus.state",
  settings: "pomodorus.settings",
  categories: "pomodorus.categories",
  selectedCategoryId: "pomodorus.selectedCategoryId",
  history: "pomodorus.history",
};

export async function getState() {
  const { [KEYS.state]: state } = await chrome.storage.local.get(KEYS.state);
  return state ?? initialState();
}

export async function setState(state) {
  await chrome.storage.local.set({ [KEYS.state]: state });
}

export async function getSettings() {
  const { [KEYS.settings]: settings } = await chrome.storage.local.get(KEYS.settings);
  return settings ? clampSettings(settings) : { ...DEFAULT_SETTINGS };
}

export async function setSettings(settings) {
  await chrome.storage.local.set({ [KEYS.settings]: clampSettings(settings) });
}

export async function getCategories() {
  const { [KEYS.categories]: categories } = await chrome.storage.local.get(KEYS.categories);
  return categories ?? [];
}

export async function setCategories(categories) {
  await chrome.storage.local.set({ [KEYS.categories]: categories });
}

export async function getSelectedCategoryId() {
  const { [KEYS.selectedCategoryId]: id } = await chrome.storage.local.get(
    KEYS.selectedCategoryId
  );
  return id ?? null;
}

export async function setSelectedCategoryId(id) {
  await chrome.storage.local.set({ [KEYS.selectedCategoryId]: id });
}

export async function getHistory() {
  const { [KEYS.history]: history } = await chrome.storage.local.get(KEYS.history);
  return history ?? [];
}

// Appends one completed work session — credited at its nominal end, at its
// full nominal duration, exactly like the web app's "ring time is not focus
// time" rule.
export async function pushHistory(entry) {
  const history = await getHistory();
  history.push(entry);
  await chrome.storage.local.set({ [KEYS.history]: history });
}

export function onChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") callback(changes);
  });
}
