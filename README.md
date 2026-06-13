# Floyd

A personal operating system built on Google Sheets, Google Apps Script, and a PWA
frontend — with a token-protected API and an MCP server that lets Claude (or any
agent) read and write the store directly.

Floyd tracks your physical state, finances, location, relationship context,
projects, tasks, and health. AI sessions read the store, converse with you, and
write structured entries back. **The sheet is the permanent record; the AI is a
temporary worker.**

---

## What Floyd Is

Not a journal, not a chatbot — a **structured mirror**. Every entry is atomic JSON
written into a live Google Sheet. The system is configured *from the sheet*: routes,
themes, dashboard cards, prompts, AI targets, retention rules, and even parsing
logic are data rows, not hardcoded code.

---

## Architecture

```
                    ┌─────────────────────────────┐
   Dashboard PWA ──▶│                             │
   Context Builder ─▶│   Apps Script web app       │──▶  Google Sheet
   Claude (MCP) ────▶│   doGet / doPost → dispatch │◀──  (source of truth)
   Android notifs ──▶│   → handler_type            │
                    └─────────────────────────────┘
```

The backend has **no bespoke per-endpoint code**. `dispatch()` looks up
`ROUTE_REGISTRY`, matches a `handler_type`, and calls a generic handler. What gets
assembled into an AI context packet is itself a table (`CONTEXT_SCHEMA`). Transforms
and meta-operations are rows (`TRANSFORM_REGISTRY`, `META_HANDLERS`).

### Clients
1. **`index.html`** — dashboard PWA. Live state, quick-log with smart tagging, voice, location/mode switching.
2. **`context.html`** — context builder + session launcher + JSON import + prompt manager.
3. **`floyd-mcp/`** — MCP server exposing `floyd_read_context`, `floyd_query_log`, `floyd_append_entries` to Claude. See [floyd-mcp/README.md](floyd-mcp/README.md).

---

## The Sheet (25 tabs)

**Data**
`PERSONAL_LOG` (atomic life entries) · `AI_SESSIONS` (session records) · `JOURNAL` ·
`CALENDAR` · `TASKS` · `NOTIFICATION_STATS` · `VALIDATION_LOG` (failed imports)

**Live state**
`SYSTEM_STATE` (key/value) · `PARTNER_STATE` · `PARTNER_CYCLE`

**Config & UI**
`CONFIG` (core settings) · `DISPLAY_CONFIG` (dashboard cards) · `ACTIONS` (buttons) ·
`AI_TARGETS` · `PROMPTS`

**Rules**
`LOG_RULES` (valid tags + retention) · `TAG_KEYWORDS` (smart-tag scoring) ·
`PROMOTION_RULES` · `NOTIFICATION_PARSERS` · `TRANSFORM_REGISTRY` · `APP_NAMES`

**Engine / meta**
`ROUTE_REGISTRY` (all endpoints) · `META_HANDLERS` (import meta ops) ·
`CONTEXT_SCHEMA` (what to assemble into context) · `CODE` (Apps Script source mirrored
as rows for AI reference — note: can drift from the deployed code)

---

## API (driven by ROUTE_REGISTRY)

**GET** — `context` / `system` (full packet) · `checkin` / `checkin_prep` / `checkin_detail` ·
`tags` · `schema` · `smart_tag` (keyword→tag scorer)

**POST** — `import_entries` · `sheet_update` (upsert any non-protected sheet) ·
`task_update` · `session_log` · `prompt_update` · `cycle_reset` · `calendar_add` ·
`batch` (mixed ops) · `/notification` + `/notifications/batch` · `resolve_validation_errors`

Core functions: `doGet` / `doPost` → `dispatch` → `handleImport`, `handleSheetWrite`,
`handleSheetRead`, `handleContextBuild`, `handleScorer`, `handleStateUpdate`, plus
meta/validation/notification helpers.

### Authentication
Every **write (POST)** must carry a `token` matching the `api_secret` row in `CONFIG`.
Missing/wrong token → `{ error: 'Unauthorized' }`. **Reads (GET) are currently open** —
anyone with the deployment URL can read the context packet (see Roadmap). The gate is
backward-compatible: blank `api_secret` = no enforcement. See [DEPLOY_auth.md](DEPLOY_auth.md).

---

## Setup

1. **Sheet** — start from the Floyd workbook (the 25 tabs above).
2. **Apps Script** — Extensions → Apps Script; deploy as a web app (execute as
   yourself). Copy the `/exec` URL.
3. **Auth** — add an `api_secret` row to `CONFIG`; ensure `dispatch()` has the auth gate
   ([DEPLOY_auth.md](DEPLOY_auth.md)).
4. **Config** — copy `config.example.js` → `config.js`, set `api_url`, `base_url`,
   `api_secret`. Gitignored; upload directly to your host.
5. **Host** — push everything except `config.js` to GitHub Pages (or any static host);
   add `config.js` separately.
6. **Install** — open the URL in mobile Chrome/Safari → Add to Home Screen.
7. **(Optional) MCP** — `cd floyd-mcp && npm install`, set env, register with Claude.

---

## Key CONFIG settings

`owner_id` · `owner_name` · `owner_birthday` (Days Alive) · `partner_id` /
`partner_name` · `currency` · `timezone` · `billing_cycle_day1/2` ·
`home_lat` / `home_lon` / `home_radius_km` / `home_mode` · `second_space_*` ·
`default_*` · per-mode `*_theme_background/card/label/text` and `*_icon` ·
`day_reset_hour` · `api_url` · `base_url` · **`api_secret`** · `system_manifest`.

---

## The session loop

1. Open the Context Builder, pick a prompt + target AI, optionally add a query.
2. Launch — the context packet copies to clipboard and the AI opens.
3. Have the session. The AI ends with a `[Import to Floyd](…?text={{base64_entries}})`
   link (entries are `btoa(JSON.stringify(array))`).
4. Tap the link → entries import, the session logs to `AI_SESSIONS`.

With the MCP server, steps 1–4 collapse: Claude reads context and appends entries
directly — no clipboard, no link.

### Entry shape & tag formats
`{ days_alive, person, tag, value, notes, confidence, ai }` — backend fills
timestamp/id/days_alive and applies retention + qualify rules.

| Tag | Format | Example |
|---|---|---|
| `#mood` | N/10 word | `7/10 calm` |
| `#sleep` | Nhrs quality | `7hrs good` |
| `#energy` | N/10 word | `8/10 focused` |
| `#health` | observation | `lower back tight` |
| `#note` / `#idea` | freeform | `add recurring task support` |
| `#balance` | numeric | `622.77` |

---

## Roadmap

- **Read protection** — gate GET `?type=context` so the full packet isn't readable by
  URL alone (deferred: a query-string token leaks via logs/referrer; a server-side
  proxy is the clean fix).
- **Data hygiene** — archive accumulated `AI_SESSIONS` and padded config rows
  (see [DEPLOY_cleanup.md](DEPLOY_cleanup.md)).
- **Deeper log search** — a `sheet_read` route over `PERSONAL_LOG` so the MCP server
  can query beyond the recent ~50-entry window.

---

## Philosophy

A personal tool, not a product — owned and modified by the person using it. The sheet
is the source of truth. The code is plumbing. The AI reads the system, converses, and
writes back what matters; when the session ends the AI is gone and the data stays.
