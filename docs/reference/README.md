# v1 UI reference

The Next.js + Convex app as it stood at `v1-nextjs` (commit `fadda7a`),
captured before the rewrite wiped it. These are the pixel target. Exact values
live in [`../design-tokens.md`](../design-tokens.md); the original markup is in
git (`git show v1-nextjs:components/timer-app.tsx`).

Captured with `scripts/capture-reference.mjs` at `deviceScaleFactor: 2`,
locale `fa-IR`, timezone `Asia/Tehran`, on a fresh account with one public
category («درس») and three dev-fast sessions.

| Viewport | Size |
| --- | --- |
| `mobile/` | 390 × 844 |
| `desktop/` | 1440 × 900 |

| Shot | What it shows |
| --- | --- |
| `01-landing-signed-out` | Landing: hero band, wordmark, pitch, CTA pair, personal note. No feed (empty feeds render nothing). |
| `02-login` | Login: both standing alerts, the form, the field hint, the back link. |
| `03-login-filled` | Same with values in both fields. Mobile only. |
| `04-app-first-run` | Timer with no categories yet — the combobox reads «اولین تسکت رو بساز» and the start button is disabled. Mobile only. |
| `05-category-create-empty` | The create form the picker opens straight into when there are no categories. Mobile only. |
| `06-category-create-filled` | Same with a name typed and the public switch on. Mobile only. |
| `07-start-screen` | The start screen proper: picker, bordered panel, − / clock / + stepper, start, settings trigger. |
| `08-category-picker` | Picker dialog with the list, the edit affordance and the "new task" row. |
| `09-settings-dialog` | The three interval rows (short break, long break, per-cycle) at the shared `sm:p-20` dialog inset. |
| `10-running-work` | Running work: task name, countdown, progress bar part-filled, cycle dots, cancel. |
| `11-landing-feed-active` | Landing with a live feed row — handle, category name, remaining time. |
| `12-ringing-work` | **The one screen with a hue.** Ring clock counting up in `rose-500`, pulsing bell, NavBar badge red and belled, confirm button. |
| `13-running-break` | The break that survived the ring time, running. |
| `14-ringing-break` | Break ringing: continue / done pair. |
| `15-landing-feed-break` | Feed row for a user on a break — no time shown. |
| `16-start-screen-after` | Back to the start screen, task and length still picked, cycle advanced. |
| `17-profile` | Public profile: range presets, focus chart, day detail for the most recent day with data. |
| `18-profile-day-detail` | Day detail: banner art, `h:mm` headline, Jalali caption, per-category row with share bar. |
| `19-app-offline` | The timer with the network cut. |

## Known gaps

Not captured, and worth knowing before you try to match them:

- **Feed empty / offline states.** The feed returns `null` when nothing is
  live, so there is no empty card to photograph — but SPEC claims the section
  always renders and holds a row's height. The code wins: it renders nothing.
- **Long break and the cycle reset**, which need four completed pomodoros.
- **Profanity refusals** in the picker and on signup.
- **A ring discovered stale on launch** (silent, no audio).
- **Private categories** in the feed and in a visitor's day detail.
- **A visitor's view** of someone else's profile (these were all shot as the
  owner, so private names are unmasked and the owner disclaimer shows).

## Discrepancies found while capturing

Things where `SPEC.md` and the shipped app disagree. The rewrite has to pick
one, and unless you say otherwise the **screenshots win**:

1. **The share-as-PNG button is back.** SPEC says "There is no share-as-PNG
   button. One was built and parked, then dropped along with `html-to-image`."
   The day detail in `18-profile-day-detail` clearly has two icon buttons above
   it (a reshuffle and a download), and `html-to-image` is still a dependency.
2. **The feed vanishes when empty.** SPEC says the heading always renders and
   the body holds a row's height so the section never disappears. `feed.tsx`
   returns `null` when there is nothing live or the client is offline.
3. **`AppHeader` is dead code** — a second header component that no route
   renders. Don't port it.
