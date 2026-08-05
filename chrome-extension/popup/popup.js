import * as engine from "../lib/engine.js";
import * as storage from "../lib/storage.js";
import * as actions from "../lib/actions.js";

const screenEl = document.getElementById("screen");
const settingsBtn = document.getElementById("settingsBtn");

let state, settings, categories, selectedCategoryId;
let workMinutesDraft = engine.DEFAULT_SETTINGS.work;
let ticker = null;
let audio = null;
let lastAudibleRingSince = null;

settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

async function loadAll() {
  state = await actions.refresh();
  settings = await storage.getSettings();
  categories = await storage.getCategories();
  selectedCategoryId = await storage.getSelectedCategoryId();
  if (state.workMinutes) workMinutesDraft = state.workMinutes;
}

async function boot() {
  await loadAll();
  render();
  startTicker();
}

function startTicker() {
  if (ticker) clearInterval(ticker);
  ticker = setInterval(async () => {
    const before = state.phase;
    state = await actions.refresh();
    if (state.phase !== before) settings = await storage.getSettings();
    render();
  }, 1000);
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

function selectedCategory() {
  return categories.find((c) => c.id === selectedCategoryId) ?? null;
}

function render() {
  screenEl.replaceChildren();
  manageAudio();

  switch (state.phase) {
    case "idle":
      screenEl.append(renderStart());
      break;
    case "work-running":
      screenEl.append(renderRunning("work"));
      break;
    case "break-running":
      screenEl.append(renderRunning("break"));
      break;
    case "work-ringing":
      screenEl.append(renderRinging("work"));
      break;
    case "break-ringing":
      screenEl.append(renderRinging("break"));
      break;
  }
}

// ---------- start screen ----------

function renderStart() {
  const wrap = h("div");
  const cat = selectedCategory();

  const cycleRow = h(
    "div",
    { class: "cycle-row" },
    `${toFa(state.cycleCount)} از ${toFa(settings.perCycle)} تا`
  );

  const stepper = h("div", { class: "stepper" }, [
    h(
      "button",
      {
        disabled: workMinutesDraft <= engine.RANGES.work.min ? "" : null,
        onclick: () => {
          workMinutesDraft = Math.max(
            engine.RANGES.work.min,
            workMinutesDraft - engine.RANGES.work.step
          );
          render();
        },
      },
      "−"
    ),
    h("div", { class: "clock" }, formatMinutes(workMinutesDraft)),
    h(
      "button",
      {
        disabled: workMinutesDraft >= engine.RANGES.work.max ? "" : null,
        onclick: () => {
          workMinutesDraft = Math.min(
            engine.RANGES.work.max,
            workMinutesDraft + engine.RANGES.work.step
          );
          render();
        },
      },
      "+"
    ),
  ]);

  const kindLabel = h("div", { class: "kind-label" }, "تایمی که میخوای تمرکز کنی");

  const picker = h(
    "div",
    { class: "category-picker", onclick: openCategoryDialog },
    [
      h("span", {}, cat ? cat.name : "یه تسک انتخاب کن"),
      cat && !cat.public ? h("span", { class: "private-badge" }, "خصوصی") : h("span", {}, "›"),
    ]
  );

  const today = h("div", { class: "today-row" }, todaySummaryText());

  const startBtn = h(
    "button",
    {
      class: "primary-btn",
      onclick: async () => {
        state = await actions.start({
          categoryId: selectedCategoryId,
          workMinutes: workMinutesDraft,
        });
        render();
      },
    },
    "شروع"
  );

  wrap.append(cycleRow, stepper, kindLabel, picker, today, startBtn);
  return wrap;
}

function todaySummaryText() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return renderTodayAsync(startOfDay);
}

function renderTodayAsync(startOfDay) {
  const el = h("span", {}, "");
  storage.getHistory().then((history) => {
    const todays = history.filter((s) => s.completedAt >= startOfDay);
    if (todays.length === 0) {
      el.textContent = "امروز تمرکز نکردی کلا";
      return;
    }
    const totalMinutes = todays.reduce((sum, s) => sum + s.durationMinutes, 0);
    el.textContent = `امروز ${toFa(todays.length)} تا — ${formatMinutes(totalMinutes)}`;
  });
  return el;
}

// ---------- running screen ----------

function renderRunning(kind) {
  const now = Date.now();
  const remaining = engine.remainingMs(state, now);
  const share = engine.elapsedShare(state, now);
  const cat = selectedCategory();

  const wrap = h("div", {});
  const track = h("div", { class: "progress-track" }, [
    h("div", { class: "progress-fill", style: `width:${Math.round(share * 100)}%` }),
  ]);

  const label =
    kind === "work"
      ? cat
        ? cat.name
        : "یه تسک خصوصی"
      : state.breakKind === "long"
      ? "چیل حسابی"
      : "چیل";

  const center = h("div", { class: "center" }, [
    h("div", { class: "kind-label" }, label),
    h("div", { class: "clock" }, engine.formatClock(remaining)),
  ]);

  const btn =
    kind === "work"
      ? h(
          "button",
          {
            class: "secondary-btn",
            onclick: async () => {
              state = await actions.cancel();
              render();
            },
          },
          "بی‌خیالش، کنسل"
        )
      : h(
          "button",
          {
            class: "secondary-btn",
            onclick: async () => {
              state = await actions.skip();
              render();
            },
          },
          "چیل بسه، بریم پای کار"
        );

  wrap.append(track, center, btn);
  return wrap;
}

// ---------- ringing screen ----------

function renderRinging(kind) {
  const now = Date.now();
  const elapsed = engine.remainingMs(state, now); // counts up while ringing
  const wrap = h("div", {});

  const track = h("div", { class: "progress-track" }, [
    h("div", { class: "progress-fill ring", style: "width:100%" }),
  ]);

  const title = kind === "work" ? "پومودورو تموم شد!" : "چیل تموم شد";
  const hint =
    kind === "work"
      ? state.breakDuration - elapsed > 0
        ? "حساب شد و رفت تو کارنامه‌ات. بزن تایید تا چیلت شروع شه"
        : "حساب شد و رفت تو کارنامه‌ات. انقد طول کشید که چیلتم همین‌جا خوردی"
      : "پایه‌ای بریم یکی دیگه؟";

  const center = h("div", { class: "center" }, [
    h("div", { class: "kind-label" }, title),
    h("div", { class: "clock ring" }, engine.formatClock(elapsed)),
    h("div", {}, `${engine.formatClock(elapsed)} داره زنگ می‌زنه`),
  ]);

  const alert = h("div", { class: "alert" }, hint);

  let actionsRow;
  if (kind === "work") {
    const label = state.breakDuration - elapsed > 0 ? "تایید، بریم چیل" : "تایید، بریم سر کار";
    actionsRow = h(
      "button",
      {
        class: "primary-btn",
        onclick: async () => {
          state = await actions.confirmWork();
          render();
        },
      },
      label
    );
  } else {
    actionsRow = h("div", { class: "btn-row" }, [
      h(
        "button",
        {
          class: "primary-btn",
          onclick: async () => {
            state = await actions.confirmBreak("continue");
            render();
          },
        },
        "شروع پومودورو بعدی"
      ),
      h(
        "button",
        {
          class: "secondary-btn",
          onclick: async () => {
            state = await actions.confirmBreak("done");
            render();
          },
        },
        "فعلاً بسمه"
      ),
    ]);
  }

  wrap.append(track, center, alert, actionsRow);
  return wrap;
}

// ---------- category dialog ----------

function openCategoryDialog() {
  const overlay = h("div", {
    style:
      "position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:flex-end;z-index:10;",
  });
  const panel = h("div", {
    style: "background:#000;border-top:1px solid #2a2a2a;padding:16px;width:100%;",
  });

  const title = h("div", { class: "kind-label" }, "یه تسک انتخاب کن");

  const list = h("div", { class: "cat-list" });
  const noneItem = h(
    "div",
    {
      class: `cat-item${selectedCategoryId === null ? " selected" : ""}`,
      onclick: async () => {
        selectedCategoryId = null;
        await storage.setSelectedCategoryId(null);
        document.body.removeChild(overlay);
        render();
      },
    },
    "بدون تسک"
  );
  list.append(noneItem);
  for (const c of categories) {
    list.append(
      h(
        "div",
        {
          class: `cat-item${selectedCategoryId === c.id ? " selected" : ""}`,
          onclick: async () => {
            selectedCategoryId = c.id;
            await storage.setSelectedCategoryId(c.id);
            document.body.removeChild(overlay);
            render();
          },
        },
        [h("span", {}, c.name), !c.public ? h("span", { class: "private-badge" }, "خصوصی") : null]
      )
    );
  }

  const nameInput = h("input", { type: "text", placeholder: "اسم تسک" });
  const publicCheck = h("input", { type: "checkbox" });
  const field = h("div", { class: "field" }, [
    nameInput,
    h("label", { class: "checkbox-row" }, [publicCheck, "پابلیک باشه؟ (اسمش تو فید دیده میشه)"]),
    h(
      "button",
      {
        class: "primary-btn",
        onclick: async () => {
          const name = nameInput.value.trim();
          if (!name || name.length > 40) return;
          const id = crypto.randomUUID();
          categories.push({ id, name, public: publicCheck.checked, createdAt: Date.now() });
          await storage.setCategories(categories);
          selectedCategoryId = id;
          await storage.setSelectedCategoryId(id);
          document.body.removeChild(overlay);
          render();
        },
      },
      "اضافه کن"
    ),
  ]);

  const closeBtn = h(
    "button",
    { class: "secondary-btn", onclick: () => document.body.removeChild(overlay) },
    "برگرد"
  );

  panel.append(title, list, field, closeBtn);
  overlay.append(panel);
  document.body.append(overlay);
}

// ---------- audio ----------

function manageAudio() {
  const ringing = state.phase === "work-ringing" || state.phase === "break-ringing";
  if (!ringing || !state.audible) {
    stopAudio();
    return;
  }
  if (lastAudibleRingSince === state.ringSince && audio) return; // already going for this ring
  lastAudibleRingSince = state.ringSince;
  startAudio();
}

function startAudio() {
  stopAudio();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let stopped = false;
  const ding = () => {
    if (stopped) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  };
  ding();
  const interval = setInterval(ding, 3000);
  audio = {
    stop: () => {
      stopped = true;
      clearInterval(interval);
      ctx.close();
    },
  };
}

function stopAudio() {
  if (audio) {
    audio.stop();
    audio = null;
  }
  lastAudibleRingSince = null;
}

// ---------- helpers ----------

function toFa(n) {
  return n.toString().replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
}

function formatMinutes(m) {
  return `${toFa(m)} دقیقه`;
}

boot();
