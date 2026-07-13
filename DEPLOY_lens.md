# DEPLOY — T038 Context Lens Engine

> **STATUS: LIVE + VERIFIED 2026-07-13.** Apps Script @129, gateway version
> c11e0223, CONTEXT_LENSES sheet created. Verified: history deep search (90 rows),
> person lens call-prep (Heidi profile + 3 correspondence), private-lens auth gate,
> CSV, MCP client. MCP tools load on next Claude restart. The steps below are the
> reproducible runbook.


Named views over the context packet: **narrow** the sections, **deepen** the
log/correspondence history past the default context caps, and optionally emit
**CSV**. Backward compatible — no `lens` param = today's full packet, so current
traffic is unaffected until a caller opts in.

Built this pass (all syntax-checked; lens logic covered by `scratchpad/lens_test.js`, 22/22):
- **`apps-script/Code.js`** — the engine: `resolveLens` / `applyLens` /
  `deepLogScan` / `deepCorrespondence` / `toCsv`, `BUILTIN_LENSES`, a `lens`
  branch inside `handleContextBuild` (section-narrowing + cap overrides + private
  token gate), `_csv` output in `doGet`, and `ensureLensesSheet` (wired into
  `run_setup` + `initFloydV3`).
- **`floyd-gateway/src/index.js`** — inject the real Apps Script secret as `?key=`
  on GET reads (so the gateway can reach token-gated readers — private lenses,
  and now also `correspondence`/`archive_tail`); bypass KV cache for any `lens` read.
- **`floyd-mcp/`** — `floyd_search_log` (deep whole-log search) + `floyd_read_lens`
  (person/funnel/history/brief/checkin) tools; `readLens` + `searchLog` in `floyd.js`.

## Lenses

| lens | sections | deep | private | needs |
|---|---|---|---|---|
| `brief` | daily-brief set | — | no | — |
| `checkin` | check-in set | — | no | — |
| `person` | `people` (filtered to who) | full log history + correspondence | **yes** | `who` |
| `funnel` | leads + people + state | correspondence (all) | **yes** | — |
| `history` | — | whole log by tags/days, **no cap** | **yes** | `tags` and/or `days` |

Private lenses require the API token (`?key=<secret>`), same gate as
`correspondence`/`archive_tail`. Through the gateway the token is injected
server-side, so the MCP just needs its normal gateway auth.

## Deploy order

1. **Apps Script** (redeploy in place — same `/exec`):
   ```
   cd apps-script && clasp push -f
   clasp deploy -i AKfycbyc2KY…HltHt5rQ -d "T038 context lenses"
   ```
   Then provision the sheet (either works, idempotent):
   - POST `run_setup` with the token, **or**
   - run `initFloydV3()` once in the Apps Script editor.
   Confirm a `CONTEXT_LENSES` tab appeared with 5 seed rows.

2. **Gateway**: `cd floyd-gateway && wrangler deploy`
   (needs `APPS_SCRIPT_SECRET` already set — it is, from Phase 1.)

3. **MCP**: no deploy; picked up on next Claude restart. `npm run smoke` if you
   want a quick client check first.

## Smoke tests (after deploy)

Replace `<GW>` with the gateway URL and `<TOK>` with `GATEWAY_TOKEN`
(or hit `/exec` directly with the Apps Script secret as `key`).

```bash
# brief lens — narrowed, non-private (should return a trimmed packet)
curl -s -H "Authorization: Bearer <TOK>" "<GW>/?type=context&lens=brief" | jq 'keys'

# history lens WITHOUT token via /exec → Unauthorized (private gate)
curl -s "<EXEC>/exec?type=context&lens=history&tags=%23mood" | jq .
# → {"error":"Unauthorized"}

# history lens deep search (through gateway; token injected)
curl -s -H "Authorization: Bearer <TOK>" "<GW>/?type=context&lens=history&tags=%23mood&days=90" | jq '.log_history | length'

# person lens call-prep
curl -s -H "Authorization: Bearer <TOK>" "<GW>/?type=context&lens=person&who=peter" | jq '{people, logs:(.log_history|length), corr:(.correspondence|length)}'

# CSV output
curl -s -H "Authorization: Bearer <TOK>" "<GW>/?type=context&lens=history&days=30&format=csv"

# missing required param → clear error
curl -s -H "Authorization: Bearer <TOK>" "<GW>/?type=context&lens=person" | jq .
# → {"error":"lens 'person' requires param 'who'"}
```

## Optional follow-ups (not done, low risk to defer)

- **Repoint the workers**: switch `floyd-brief` to `?type=context&lens=brief` and
  `floyd-chat` to `lens=checkin`, then retire the hardcoded `trimContext`. Left
  as-is this pass to avoid touching the live nightly brief without a live test —
  the lens engine is proven, but the brief's exact section needs deserve a real run.
- **Explorer page**: a small PWA view over the lenses (person/funnel call-prep,
  history search) — the last item in the T038 spec.
