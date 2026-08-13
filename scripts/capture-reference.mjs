/**
 * Capture the v1 UI as the pixel reference for the Go/React rewrite.
 *
 * Throwaway: it runs once against the old Next.js app before the wipe, and
 * dies with it. Requires `npx convex dev` and `npm run dev` already running,
 * and DEV_FAST_POMODORO=1 on the dev deployment so 3-second sessions still
 * reach the sessions log (otherwise the profile chart has nothing to draw).
 *
 *   node scripts/capture-reference.mjs
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = "https://localhost:3000";
const OUT = "docs/reference";

const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
};

// Fresh account per run: the flow depends on "no categories yet" for the
// first-run screens, and the handle is immutable so it can't be reused.
const USER = `ref${Date.now().toString(36)}`;
const PASS = "reference";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newContext(browser, viewport) {
  return browser.newContext({
    viewport,
    ignoreHTTPSErrors: true, // next dev --experimental-https is self-signed
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    deviceScaleFactor: 2,
    permissions: [], // never let the notification prompt into a screenshot
  });
}

async function shot(page, name, viewportName) {
  await page.screenshot({
    path: `${OUT}/${viewportName}/${name}.png`,
    fullPage: true,
  });
  console.log(`  ✓ ${viewportName}/${name}`);
}

/** The timer's ± / start / confirm controls, by their Persian labels. */
const byText = (page, text) => page.getByRole("button", { name: text });

async function run(browser, viewportName, { signUp }) {
  console.log(`\n== ${viewportName} ==`);
  const viewport = VIEWPORTS[viewportName];
  const ctx = await newContext(browser, viewport);
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && console.log("   js:", m.text()));

  // --- public pages, signed out -------------------------------------------
  await page.goto(BASE, { waitUntil: "networkidle" });
  await shot(page, "01-landing-signed-out", viewportName);

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await shot(page, "02-login", viewportName);

  // --- sign in ------------------------------------------------------------
  await page.fill("#username", USER);
  await page.fill("#password", PASS);
  if (signUp) await shot(page, "03-login-filled", viewportName);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/app", { timeout: 20000 });
  // The timer renders a "you need internet to sign in" line until the client
  // has both an auth state and a cached username, so wait for the real UI
  // rather than for the network to fall quiet.
  await page.getByRole("combobox").waitFor({ state: "visible", timeout: 30000 });
  await page.waitForTimeout(800);

  if (signUp) {
    // No categories yet: the picker's combobox reads "make your first task",
    // and opening it lands straight on the create form rather than the list.
    await shot(page, "04-app-first-run", viewportName);
    await page.getByRole("combobox").click();
    await page.waitForTimeout(500);
    await shot(page, "05-category-create-empty", viewportName);
    await page.fill('input[placeholder="اسم تسک"]', "درس");
    await shot(page, "06-category-create-filled", viewportName);
    await byText(page, "اضافه کن").click();
    await page.waitForTimeout(800);
  }

  // --- start screen -------------------------------------------------------
  await page.waitForTimeout(500);
  await shot(page, "07-start-screen", viewportName);

  await page.getByRole("combobox").click();
  await page.waitForTimeout(500);
  await shot(page, "08-category-picker", viewportName);
  if (signUp) {
    // Creating a category already selected it.
    await page.keyboard.press("Escape");
  } else {
    // The selected category is device-local and never synced, so a second
    // browser profile arrives with the category list but nothing picked —
    // and the start button stays disabled until something is.
    await page.getByRole("option", { name: "درس" }).click();
  }
  await page.waitForTimeout(600);

  await byText(page, "تنظیم تایمرها").click();
  await page.waitForTimeout(400);
  await shot(page, "09-settings-dialog", viewportName);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // --- a session, at dev speed (3s nominal-25m) ---------------------------
  // The feed page is opened and subscribed *first*. Presence is published on
  // start and cleared the moment the session stops running locally, and a fast
  // session only runs for three seconds — load the landing after starting and
  // the row is already gone by the time the query lands.
  const feed = await ctx.newPage();
  await feed.goto(BASE, { waitUntil: "networkidle" });
  await page.bringToFront();

  await byText(page, "شروع").click();
  await page.waitForTimeout(900); // mid-run, progress bar partly filled
  await shot(page, "10-running-work", viewportName);
  await shot(feed, "11-landing-feed-active", viewportName);

  await page.bringToFront();
  await page.waitForTimeout(3000); // past the 3s bell
  await shot(page, "12-ringing-work", viewportName);

  // Confirm → the surviving break starts.
  await page.getByRole("button", { name: /^تایید/ }).click();
  await page.waitForTimeout(900);
  await shot(page, "13-running-break", viewportName);
  await shot(feed, "15-landing-feed-break", viewportName);

  await page.bringToFront();
  await page.waitForTimeout(3000);
  await shot(page, "14-ringing-break", viewportName);

  await byText(page, "فعلاً بسمه").click();
  await page.waitForTimeout(600);
  await shot(page, "16-start-screen-after", viewportName);

  // A couple more so the chart and the day detail have something to draw.
  for (let i = 0; i < 2; i++) {
    await byText(page, "شروع").click();
    await page.waitForTimeout(3500);
    await page.getByRole("button", { name: /^تایید/ }).click();
    await page.waitForTimeout(600);
    await byText(page, "فعلاً بسمه").click().catch(() => {});
    await page.waitForTimeout(600);
  }

  // --- profile ------------------------------------------------------------
  await page.goto(`${BASE}/u/${USER}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500); // let the chart animate in
  await shot(page, "17-profile", viewportName);

  // Pointing at the chart selects a day. Zero days deliberately render no
  // panel at all, so walk in from the newest day until one appears — only
  // today has focus time in a freshly created account.
  const chart = page.locator(".recharts-surface").first();
  const panel = page.getByText("ساعت کار متمرکز");
  if (await chart.count()) {
    const box = await chart.boundingBox();
    for (const f of [0.99, 0.95, 0.85, 0.75, 0.6]) {
      if (!box) break;
      await page.mouse.move(box.x + box.width * f, box.y + box.height / 2);
      await page.waitForTimeout(900);
      if (await panel.count()) break;
    }
    await page.waitForTimeout(600);
    await shot(page, "18-profile-day-detail", viewportName);
  }

  // --- offline ------------------------------------------------------------
  await ctx.setOffline(true);
  await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, "19-app-offline", viewportName);
  await ctx.setOffline(false);

  await ctx.close();
}

const browser = await chromium.launch();
for (const name of Object.keys(VIEWPORTS)) {
  await mkdir(`${OUT}/${name}`, { recursive: true });
}
try {
  await run(browser, "mobile", { signUp: true });
  await run(browser, "desktop", { signUp: false });
} finally {
  await browser.close();
}
console.log(`\nDone. Account used: ${USER}`);
