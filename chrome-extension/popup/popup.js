import * as engine from "../lib/engine.js";
import * as storage from "../lib/storage.js";
import * as actions from "../lib/actions.js";
import * as categoriesLib from "../lib/categories.js";
import * as backend from "../lib/backend.js";
import * as sync from "../lib/sync.js";

const screenEl = document.getElementById("screen");
const navEl = document.getElementById("nav");
const settingsBtn = document.getElementById("settingsBtn");

let state, settings, categories, selectedCategoryId, auth;
let workMinutesDraft = engine.DEFAULT_SETTINGS.work;
let tab = "timer"; // 'timer' | 'feed' | 'account'
let ticker = null;
let feedTicker = null;
let audio = null;
let lastAudibleRingSince = null;
let loginError = "";
let loginBusy = false;

settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

async function loadAll() {
  state = await actions.refresh();
  settings = await storage.getSettings();
  categories = await storage.getCategories();
  selectedCategoryId = await storage.getSelectedCategoryId();
  auth = await storage.getAuth();
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
    if (tab === "timer") render();
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

function setTab(next) {
  tab = next;
  stopFeedPolling();
  render();
}

function renderNav() {
  navEl.hidden = false;
  navEl.replaceChildren(
    navTab("timer", "تایمر"),
    navTab("feed", "کیا آنلاینن؟"),
    navTab("account", auth ? "اکانت" : "لاگین")
  );
}

function navTab(id, label) {
  return h(
    "button",
    { class: `nav-tab${tab === id ? " active" : ""}`, onclick: () => setTab(id) },
    label
  );
}

function render() {
  renderNav();
  screenEl.replaceChildren();
  manageAudio();

  if (tab === "feed") {
    screenEl.append(renderFeed());
    startFeedPolling();
    return;
  }
  if (tab === "account") {
    screenEl.append(auth ? renderAccount() : renderLogin());
    return;
  }

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

  const today = h("div", { class: "today-row" }, "");
  renderTodayInto(today);

  const startBtn = h(
    "button",
    {
      class: "primary-btn",
      onclick: async () => {
        state = await actions.start({ category: cat, workMinutes: workMinutesDraft });
        render();
      },
    },
    "شروع"
  );

  wrap.append(cycleRow, stepper, kindLabel, picker, today, startBtn);
  return wrap;
}

async function renderTodayInto(el) {
  if (auth) {
    try {
      const remote = await backend.todayFocusRemote();
      el.textContent =
        remote && remote.count > 0
          ? `امروز ${toFa(remote.count)} تا — ${formatMinutes(Math.round(remote.totalMs / 60000))}`
          : "امروز تمرکز نکردی کلا";
      return;
    } catch {
      // fall through to local
    }
  }
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const history = await storage.getHistory();
  const todays = history.filter((s) => s.completedAt >= startOfDay);
  el.textContent =
    todays.length === 0
      ? "امروز تمرکز نکردی کلا"
      : `امروز ${toFa(todays.length)} تا — ${formatMinutes(
          todays.reduce((sum, s) => sum + s.durationMinutes, 0)
        )}`;
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
  const publicCheck = h("input", { type: "checkbox", checked: "" });
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
          const id = await categoriesLib.createCategory({ name, isPublic: publicCheck.checked });
          categories = await storage.getCategories();
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

// ---------- login ----------

function renderLogin() {
  const wrap = h("div", { class: "login" });
  wrap.append(h("div", { class: "kind-label" }, "لاگینش خیلی سادست"));
  wrap.append(
    h(
      "div",
      { class: "login-lead" },
      "فقط یه یوزرنیم پسورد بزنی اکانتت ساخته میشه و لاگین میشی. ریست پسوورد نداریم."
    )
  );

  const userInput = h("input", { type: "text", placeholder: "یوزرنیم" });
  const passInput = h("input", { type: "password", placeholder: "پسورد" });
  const hint = h("div", { class: "field-hint" }, "حروف انگلیسی کوچیک، عدد و آندرلاین");

  const errorBox = h("div", {});
  if (loginError) errorBox.append(h("div", { class: "alert" }, loginError));

  const submitBtn = h(
    "button",
    {
      class: "primary-btn",
      onclick: async () => {
        if (loginBusy) return;
        loginBusy = true;
        loginError = "";
        render();
        try {
          await backend.signIn(userInput.value, passInput.value);
          auth = await storage.getAuth();
          loginBusy = false;
          tab = "account";
          render();
        } catch (err) {
          loginBusy = false;
          loginError = backend.describeError(err);
          render();
        }
      },
    },
    loginBusy ? "صبر کن…" : "بزن بریم"
  );

  wrap.append(
    h("div", { class: "field" }, [userInput, hint]),
    h("div", { class: "field" }, [passInput]),
    errorBox,
    submitBtn
  );
  return wrap;
}

// ---------- account / profile ----------

function renderAccount() {
  const wrap = h("div", { class: "account" });
  wrap.append(h("div", { class: "clock" }, "@" + auth.username));

  const chartHost = h("div", { class: "chart-host" }, "در حال بارگذاری…");
  wrap.append(chartHost);
  loadProfileChart(chartHost);

  const signOutBtn = h(
    "button",
    {
      class: "secondary-btn",
      onclick: async () => {
        await backend.signOut();
        auth = null;
        categories = await storage.getCategories();
        tab = "timer";
        render();
      },
    },
    "لاگ اوت کن"
  );
  wrap.append(signOutBtn);
  return wrap;
}

async function loadProfileChart(host) {
  try {
    const chart = await backend.profileChart(auth.username, 7);
    host.replaceChildren(renderChart(chart));
  } catch (err) {
    host.replaceChildren(h("div", { class: "alert" }, backend.describeError(err)));
  }
}

function renderChart(chart) {
  if (!chart || chart.days.length === 0) return h("div", { class: "today-row" }, "چیزی نیست هنوز");
  const days = chart.days;
  const maxMs = Math.max(1, ...days.map((d) => d.totalMs));
  const w = 300;
  const barW = w / days.length - 4;
  const barsHeight = 80;

  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${barsHeight + 20}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", barsHeight + 20);

  days.forEach((d, i) => {
    const barH = Math.max(1, (d.totalMs / maxMs) * barsHeight);
    const rect = document.createElementNS(svgNs, "rect");
    rect.setAttribute("x", String(i * (barW + 4)));
    rect.setAttribute("y", String(barsHeight - barH));
    rect.setAttribute("width", String(barW));
    rect.setAttribute("height", String(barH));
    rect.setAttribute("fill", d.totalMs > 0 ? "#ffffff" : "#2a2a2a");
    svg.append(rect);
  });

  const wrap = h("div", {}, []);
  wrap.append(svg);
  const totalWeek = days.reduce((sum, d) => sum + d.totalMs, 0);
  wrap.append(
    h(
      "div",
      { class: "today-row" },
      `۷ روز اخیر — ${formatMinutes(Math.round(totalWeek / 60000))}`
    )
  );
  return wrap;
}

// ---------- feed ----------

function startFeedPolling() {
  if (feedTicker) return;
  feedTicker = setInterval(async () => {
    if (tab !== "feed") return stopFeedPolling();
    await refreshFeedInto(document.getElementById("feedList"));
  }, 4000);
}

function stopFeedPolling() {
  if (feedTicker) {
    clearInterval(feedTicker);
    feedTicker = null;
  }
}

function renderFeed() {
  const wrap = h("div", { class: "feed" });
  const list = h("div", { class: "cat-list", id: "feedList" }, "در حال بارگذاری…");
  wrap.append(list);
  refreshFeedInto(list);
  return wrap;
}

async function refreshFeedInto(list) {
  if (!list) return;
  try {
    const feed = await backend.activeFeed();
    if (!feed || feed.length === 0) {
      list.replaceChildren(h("div", { class: "today-row" }, "الان کسی آنلاین نیست 😴"));
      return;
    }
    list.replaceChildren(
      ...feed.map((item) => {
        const statusText =
          item.kind === "work" ? (item.label ? item.label : "یه تسک خصوصی") : "داره چیل می‌کنه";
        return h("div", { class: "cat-item" }, [
          h("span", {}, `${item.isMe ? "شما" : "@" + item.username}`),
          h("span", { class: "private-badge" }, statusText),
        ]);
      })
    );
  } catch (err) {
    list.replaceChildren(h("div", { class: "alert" }, backend.describeError(err)));
  }
}

// ---------- audio ----------

function manageAudio() {
  const ringing = state.phase === "work-ringing" || state.phase === "break-ringing";
  if (!ringing || !state.audible || tab !== "timer") {
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
