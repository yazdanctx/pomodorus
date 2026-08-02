# Profane names are refused at creation, and filtered on the way to the feed

Two pieces of user writing go out to strangers: a public category name, which appears in the global feed, and a username, which appears in the feed, on a profile and in a profile URL. There is no moderation queue, no report button and no admin — the app is one person's, and the feed is on the public landing page. So the writing is checked against a wordlist.

The list lives in `lib/profanity.json` and is rebuilt by `scripts/build-profanity.ts`, which merges five public sources — [amirshnll/Persian-Swear-Words](https://github.com/amirshnll/Persian-Swear-Words), the `persian-bad-words` package, [stream-guard](https://github.com/farshidrezaei/stream-guard)'s dictionary, LDNOOBW's `fa` and `en` files, and words mined from the offensive rows of a [Persian toxic-comment dataset](https://github.com/ghaninia/toxicity_detection) — and then applies this app's own judgement. It comes to ~420 Persian terms and ~450 Latin ones. Adding a word later means editing `EXTRA_FA` / `BLOCKED_FA` / `EXCLUDE` in that script and running it again; the JSON is not edited by hand.

All the sources carry a great deal that is not profanity — literal animals, ethnicities, drugs, clinical anatomy, and ordinary verbs like «کردن» — and the mining adds more of the same, so about 170 entries are cut. What remains was checked against a 50k-word Persian frequency corpus: it flags 298 of those words, all genuine except «آبله» (smallpox), which normalizes identically to «ابله» and cannot be separated from it. The Latin half was checked the same way against 370k English words, which is how `rapist` (in every *therapist*), `rimming` (in *trimming*), `raping` (in *scraping*) and `cialis` (in *socialist*) came to be matched as whole tokens or dropped.

`faBlocked` is a separate key for names the app's owner wants out of the feed — currently «خامنه‌ای». They are not profanity and are kept apart so nobody has to guess which list a word is on, but they match identically.

## Where the check runs

Four places, each for its own reason:

- **`convex/auth.ts`, in `afterUserCreatedOrUpdated`** — a username is immutable, so the only moment to refuse one is the moment it is minted. Deliberately *not* in `authorize`: that runs for sign-in too, and would lock out an account created before the wordlist existed. Such an account keeps working; the feed simply never shows it.
- **`lib/local/device.ts`, in `createCategory`/`updateCategory`** — categories are created and renamed offline (ADR 0001), so the rule has to be on the device or it is not a rule at all. It also has to cover renames, or a clean category becomes a profane one.
- **`convex/sync.ts`, in `validName`** — the device is not trusted with it. The pending queue is a JSON blob in localStorage that anyone can hand-edit, and a name pushed from there would reach the feed.
- **`lib/presence.ts`, in `accept` and `isShowable`** — the feed's own gate, which is what catches rows and usernames written before any of the above existed.

## Consequences

- A refused name is refused *whole*: the feed drops the item rather than masking the label, because a masked label still leaves the item making its point under a username, and there is nothing to gain by keeping the row.
- The wordlist ships in the client bundle (~15KB). That is the price of the rule working offline, and it is the same order as `copy.json`.
- Spelling a word out — `س ک س`, `k_o_s` — is folded back together: a run of three or more single letters is read as the word it spells. Two in a row is not, because «کس و کیر» losing its «و» is not an evasion.
- A false positive costs a real person their category name, or their spot in the feed, with a message they will find unfair. A false negative costs one crude word on the landing page for at most one session length. The first is worse, so ambiguity resolves in favour of showing — hence the cuts above, and hence matching whole words with a short list of Persian suffixes rather than substrings (`کونده` sits inside «ترکونده», `اشغال` inside «اشغالگر»).
- Nothing is filtered on the way *out* to the person who wrote it: this is about what strangers are shown, and a user's own device and profile are not that.

## Considered options

- **Mask the label, keep the row** — rejected above.
- **Check only at the feed** — rejected: it lets the word into the database and tells the person nothing, so they keep a category that has quietly stopped appearing.
- **Check only at creation** — rejected: usernames predate the list, and the queue can be edited by hand.
- **A profanity API** — rejected: a network call on the offline path is not available when the category is created, and this is a personal app with no budget for one.
