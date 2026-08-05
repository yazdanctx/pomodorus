import * as engine from "../lib/engine.js";
import * as storage from "../lib/storage.js";

const screen = document.getElementById("settingsScreen");

const ROWS = [
  { key: "work", label: "طول پومودورو" },
  { key: "short", label: "چیل کوتاه" },
  { key: "long", label: "چیل حسابی" },
  { key: "perCycle", label: "پومودورو تا چیل حسابی" },
];

let settings;

function toFa(n) {
  return n.toString().replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
}

function valueLabel(key, n) {
  return key === "perCycle" ? `${toFa(n)} تا` : `${toFa(n)} دقیقه`;
}

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let savedNote;

function render() {
  screen.replaceChildren();
  for (const { key, label } of ROWS) {
    const range = engine.RANGES[key];
    const row = h("div", { class: "row" }, [
      h("span", { class: "row-label" }, label),
      h("div", { class: "row-stepper" }, [
        h(
          "button",
          {
            disabled: settings[key] <= range.min ? "" : null,
            onclick: () => update(key, settings[key] - range.step),
          },
          "−"
        ),
        h("span", { class: "row-value" }, valueLabel(key, settings[key])),
        h(
          "button",
          {
            disabled: settings[key] >= range.max ? "" : null,
            onclick: () => update(key, settings[key] + range.step),
          },
          "+"
        ),
      ]),
    ]);
    screen.append(row);
  }
  const note = h(
    "div",
    { class: "note" },
    "پیش‌فرضا همون تکنیک اصلی پومودوروئه: ۲۵ / ۵ / ۲۰ و هر ۴ تا یه چیل حسابی. تنظیمات فقط رو همین دستگاه ذخیره میشه."
  );
  savedNote = h("div", { class: "saved" }, "");
  screen.append(note, savedNote);
}

async function update(key, value) {
  settings = engine.clampSettings({ ...settings, [key]: value });
  await storage.setSettings(settings);
  render();
  savedNote.textContent = "ذخیره شد ✓";
  setTimeout(() => {
    if (savedNote) savedNote.textContent = "";
  }, 1200);
}

async function boot() {
  settings = await storage.getSettings();
  render();
}

boot();
