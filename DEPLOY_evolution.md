# DEPLOY — evolution loop

Brings the evolution engine live (spec: `EVOLUTION_LOOP.md`). Code is committed;
these are the steps only you can run (sheet creation, Apps Script push, Worker
deploy). Ships with **auto-apply OFF** — that flip is the last step, on purpose.

## 1. Apps Script — executor + PROPOSALS sheet

1. Push the updated `apps-script/Code.js` to the bound script (clasp push, or
   paste into the Apps Script editor).
2. **Redeploy in place** on the existing deployment id so `/exec` stays stable
   (Deploy → Manage deployments → edit → new version). Do NOT create a new
   deployment — every client points at the current URL.
3. In the editor, run `ensureProposalsSheet()` once. It creates the `PROPOSALS`
   tab (`id|created|source|type|summary|packet|risk|status|applied|result`) and
   adds the `proposals` + `evolution_read` GET routes. Idempotent.

### Unit-test the executor before wiring AI (spec §7.2)

Token-gated POSTs to `/exec` (use the real `API_SECRET`). Add a throwaway row to
`PROPOSALS` first, or test the route shape directly. Example auto op:

```bash
# 1) seed a proposal row (sheet_update), then:
curl -s -X POST "$EXEC" -H 'content-type: application/json' -d '{
  "token":"'"$SECRET"'","key":"apply_proposal","id":"<row id>"
}'
```

Verify each verb: `add_tag` (→ LOG_RULES + TAG_KEYWORDS rows), `add_card`
(→ DISPLAY_CONFIG), `retire_flag` (→ SYSTEM_STATE value `retired`),
`propose_coach` (→ PROJECTS row status=proposed). Confirm the guards reject:
- `auto:true` + `set_config` / `track_metric` → "tap-only".
- any op touching `#balance` / `#odometer` / `#cycle_*` → "protected".
- any secret/token/api_key target → "refusing secret key".
- re-applying an `applied` row → no-op replay (idempotent).

## 2. floyd-brief — reflection (auto-apply OFF)

```bash
cd floyd-brief-worker && npx wrangler deploy
```

Vars already set in `wrangler.jsonc`: `REFLECT_MODEL=claude-sonnet-4-6`,
`REFLECT_AUTOAPPLY=off`. Secrets unchanged (`ANTHROPIC_API_KEY`, `FLOYD_TOKEN`).

Manual run (no waiting for cron):

```bash
curl -s "https://floyd-brief.<acct>.workers.dev/?key=$FLOYD_TOKEN&task=reflect"
```

Then **watch `PROPOSALS` for a few days.** Reflection caps at ≤2/day, dedupes
against open rows, and biases to silence (most nights write nothing).

## 3. floyd-checkin — proposals hub

```bash
cd floyd-checkin && npx wrangler deploy
```

Adds `/proposals` (key-gated hub), `/proposals/apply`, `/proposals/reject`.
The dashboard already links to it (config.js `checkin_url`, built client-side
with the token — never written to a sheet).

## 4. Flip auto-apply ON (only once proposals read trustworthy — spec §7.4)

Set `REFLECT_AUTOAPPLY=on` in `floyd-brief-worker/wrangler.jsonc` and redeploy.
From then on `risk:auto` packets self-apply at reflection time and get a quiet
`🔧 Floyd adjusted: …` line in the morning brief. `risk:tap` packets always wait
for your tap on the hub regardless.

## Rollback

- Auto-apply: set `REFLECT_AUTOAPPLY=off`, redeploy floyd-brief.
- Stop reflection entirely: remove `maybeReflect(env)` from the `scheduled`
  `Promise.allSettled([...])` in `floyd-brief-worker/src/index.js`, redeploy.
- A bad mutation: it went through the normal write path, so it's an ordinary
  sheet edit — fix the row by hand. No row was deleted (executor never deletes).
