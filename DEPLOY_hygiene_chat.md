# DEPLOY — Phase 4 hygiene + chat polish (2026-06-23)

Four roadmap items, three deploy surfaces. Nothing here changes behavior until
deployed. Order doesn't matter between surfaces, but within each, follow the steps.

## 1. Apps Script — decouple `pushFloydMode` from `getSystemData`

`getSystemData` (the dashboard read) no longer side-channels a Pi presence push on
every read. Presence freshness now belongs solely to the `floydModeHeartbeat`
time-trigger, bumped 6h → **1h** so the Pi never falls back to its dusk/1am
failsafe while Peter is home.

```bash
cd apps-script
clasp push                    # pushes Code.js + floydModePush.js
# redeploy in place on the live deployment id (keeps /exec stable) — same as prior deploys
```
Then **in the Apps Script editor, run `installFloydModeTrigger()` once** to replace
the old 6-hourly trigger with the hourly one. (Without this the code change alone
leaves presence refreshing only every 6h.)

Verify: dashboard still loads; after ~1h a `floyd_mode_last` cache refresh / Pi
`/mode` hit shows the heartbeat is carrying presence. Roomba should keep deferring
while Peter is home.

## 2. Pages deploy script — dedupe `public/` vs root

`public/` is the gitignored Pages artifact; repo root is the single source of
truth. New `scripts/deploy-pages.sh` syncs root → `public/` and deploys, replacing
the manual `cp … public/ && wrangler pages deploy …` ritual.

```bash
./scripts/deploy-pages.sh --dry-run   # sync only, prints what would ship
./scripts/deploy-pages.sh             # sync + wrangler pages deploy
```

## 3. floyd-chat — KV context cache

`wrangler.jsonc` now binds `FLOYD_CACHE` (reuses the gateway's KV namespace
`f3fe9c7bfbc54f17ab33e5f561c55425`; no new namespace to create). Context is cached
two layers: L1 Cache API + L2 KV (`chat:context`, 5 min).

```bash
cd floyd-chat
wrangler deploy
```
Verify: first turn ~normal; subsequent turns reliably fast (no more intermittent
~6s). Check `wrangler tail` shows no `kv` errors.

## 4. floyd-chat + frontend — streaming replies

Worker gained an SSE path (`{…, stream:true}` → `text/event-stream`); the JSON
path is unchanged for any non-streaming caller. `checkin.html` now streams by
default and **auto-falls-back to JSON** if it meets a non-streaming Worker, so
deploy order is safe.

- Worker: covered by the `wrangler deploy` in step 3.
- Frontend: `./scripts/deploy-pages.sh` (step 2).

**Live test (do this — streaming + tool-loop SSE could not be tested locally):**
open `https://floyd.tuliptown.ca/checkin.html` on the phone, say something
loggable ("slept 8 hours, mood's an 8"). Expect: the reply types in live, green
`✓` log chips appear as it parses, and the entry lands in PERSONAL_LOG **once**
(watch for any double-log — the no-auto-retry design should prevent it). If the
reply doesn't stream, check `wrangler tail` for an Anthropic stream error; the
frontend will have fallen back to JSON so the check-in still works.
