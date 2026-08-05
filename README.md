# Pomodorus

A very minimal Persian-language pomodoro app: a local-first timer, public profiles with a focus chart, and a realtime global activity feed. Installable as a PWA and fully usable offline.

Next.js (App Router) + Convex, TypeScript, Tailwind, shadcn/ui.

- `SPEC.md` — what the app does, feature by feature.
- `CONTEXT.md` — the domain language. Read this before naming anything.
- `docs/adr/` — decisions and why they were made. `0001` explains the local-first timer.
- `DEPLOY.md` — production (Vercel + Convex).
- `chrome-extension/` — a standalone, account-free Chrome extension port of the local timer. See [`chrome-extension/README.md`](chrome-extension/README.md).

## Requirements

- **Node 20 or newer** (developed on 24).
- A **Convex account** — free tier is plenty. The backend is Convex; there is no separate database to install.

## Setup

```bash
git clone https://github.com/yazdanctx/pomodorus.git
cd pomodorus
npm install
```

### Point it at a Convex deployment

`npx convex dev` creates a deployment, writes `.env.local` for you, and then keeps running to sync `convex/` on every save:

```bash
npx convex login   # first time only
npx convex dev
```

Leave it running. It writes three variables to `.env.local` (gitignored):

| Variable | What it is |
| --- | --- |
| `CONVEX_DEPLOYMENT` | The deployment `npx convex dev` syncs to |
| `NEXT_PUBLIC_CONVEX_URL` | The deployment's client API URL |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | The deployment's HTTP-actions URL, used by auth |

`.env.production` is committed and pins `NEXT_PUBLIC_CONVEX_URL` to the production deployment. `.env.local` overrides it, so local work never touches production.

### Generate auth keys

Signup and login need a keypair on the Convex deployment. Once per deployment:

```bash
npx @convex-dev/auth
```

This sets `JWT_PRIVATE_KEY` and `JWKS` on it. Without them, login fails while the rest of the app still loads.

### Run it

In a second terminal, with `npx convex dev` still going:

```bash
npm run dev
```

Open **https://localhost:3000** — note the **https**. The dev server runs TLS via `next dev --experimental-https`, because notifications and service workers need a secure context. Next generates a self-signed certificate into `certificates/` on first run; your browser will warn about it once, and you accept it.

Sign in with a username (`[a-z0-9_]{3,20}`) and a password. There is no separate signup: a username nobody has taken is created on the spot, and any non-empty password is accepted, so `test` / `test` works. The username is your only public identity and cannot be changed later.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server, HTTPS on `localhost:3000` |
| `npx convex dev` | Syncs `convex/` to your dev deployment; keep it running alongside |
| `npm test` | Unit tests (`node:test` via `tsx`) |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | Typecheck |
| `npm run build` | Production build |
| `npm start` | Serve a production build |

There is no test-watch script; `npx tsx --test tests/some.test.ts` runs one file.

Three kinds of test, all under `node:test`:

- **Pure logic** — most of `tests/`, plain function calls.
- **Convex functions**, against an in-memory backend via `convex-test` (`tests/sync-push.test.ts`). Real queries and writes, not mocks.
- **React**, via `@testing-library/react` on `@happy-dom/global-registrator` (`tests/sync-drain.test.ts`). Any test that renders must `import "./dom"` **first** — ESM runs imports in order, and that is what puts `document` and `localStorage` in place before React or `lib/local/store` are evaluated.

The package is `"type": "module"`, which is load-bearing rather than stylistic. `@convex-dev/auth/server` publishes no `require` export, so the Convex tests cannot run at all under the CommonJS loader. Marking only *some* directories as ESM is worse than not doing it: `lib/local/store` keeps module-level state, and loading it as both CJS and ESM gives you two copies of it, so a test seeds one and the component under test reads the other. That failure is silent — the tests pass while asserting nothing.

## Dev fast mode

In dev builds every session finishes after **3 seconds** while being recorded at its full nominal duration, so you can exercise a whole 4-session cycle in under a minute. `sync.push` drops these unless `DEV_FAST_POMODORO` is set on the deployment:

```bash
npx convex env set DEV_FAST_POMODORO 1
```

Leave it unset on production, or fake sessions would be credited there.

## Testing offline and the PWA

The service worker registers in **production builds only** — `next dev` never caches. To exercise offline behaviour:

```bash
npm run build && npm start
```

Visit once while signed in, then go offline. `/app` stays fully functional (timer, categories, your own history from local data); `/` loads from cache with the feed replaced by a notice; `/u/[username]` is online-only. After changing cached assets, bump `VERSION` in `public/sw.js` so installed clients refresh.

Offline use requires having signed in at least once on that device.

## How the code is laid out

```
app/            routes: / (landing), /app (timer), /u/[username] (profile), /login
components/     UI. sync-engine.tsx is headless glue, mounted once in the layout
convex/         schema, queries, mutations. sync.ts is the whole sync protocol
lib/local/      the local-first timer: device.ts holds the rules, store.ts the adapter
lib/            focus-history.ts, presence.ts, banners.ts, format.ts, copy.ts
tests/          unit tests for the pure modules
public/banners/ day-card art — drop in an image and it is picked up automatically
```

Two things worth knowing before editing:

- **The timer is local-first.** The device that runs a session owns it; Convex is an append-only log, not the source of truth. Every rule lives in `lib/local/device.ts` as one `apply(state, command, env)` — pure, with the clock handed in. `lib/local/store.ts` is the only thing that touches `localStorage`, `Date.now` or `crypto.randomUUID`. Add rules to `device.ts`, not to components.
- **All user-facing text is in `lib/copy.json`**, in deliberately casual Persian, including server error messages. Never hardcode a string in a component. Repo docs like this one are not copy and stay formal.

Persian digits and Jalali dates go through `lib/format.ts`. The UI is RTL with a single hard-coded black theme and no corner radius — there is no theme toggle to add.

## Regenerating icons

Every icon comes from `scripts/icon*.svg`. After editing those:

```bash
npm install --no-save sharp
node scripts/gen-icons.mjs
```
