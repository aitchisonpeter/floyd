# Floyd

A personal operating system built on Google Sheets, Google Apps Script, and a PWA frontend. Floyd tracks your physical state, finances, location, relationship context, projects, tasks, and health in real time — and uses AI sessions to keep everything current.

---

## What Floyd Is

Floyd is not a journal. It is not a chatbot. It is a structured mirror.

Every conversation with an AI produces atomic JSON entries that write back into a live Google Sheet. The AI is a temporary interface. The sheet is the permanent record.

The system is fully configurable from the sheet. Nothing is hardcoded in the frontend. Themes, dashboard cards, prompts, AI targets, retention rules — all driven by data.

---

## How It Works

```
Google Sheet (data) ←→ Apps Script (API) ←→ PWA (interface) ←→ AI (session)
```

1. The dashboard (`index.html`) reads live state from the API and renders it
2. The context builder (`context.html`) assembles a context payload — identity, state, log entries, tasks, session history
3. You select a prompt, filters, and target AI — the context copies to clipboard
4. You paste into the AI and have a session
5. The AI outputs a Floyd import link at the end
6. You tap the link — entries import, AI session logs, system updates

---

## File Structure

```
floyd/
  index.html          ← Dashboard PWA
  context.html        ← Context builder and session launcher
  manifest.json       ← PWA manifest
  config.js           ← Your private config (gitignored)
  config.example.js   ← Template for new deployments
  .gitignore
  README.md
  tuliptown.webp      ← Home mode icon
  travel.webp         ← Travel mode icon
  bdv_icon.png        ← Favicon
```

---

## Setup

### 1. Google Sheet
Copy the Floyd template sheet. It contains these tabs:
`CONFIG` `SYSTEM_STATE` `PERSONAL_LOG` `DISPLAY_CONFIG` `ACTIONS` `PROMPTS` `AI_TARGETS` `AI_SESSIONS` `TASKS` `LOG_RULES` `PARTNER` `PROMOTION_RULES` `ENGINE_SPECS` `LOG`

### 2. Apps Script
Open Extensions → Apps Script in your sheet. Paste the contents of `FLOYD_code.gs`. Deploy as a web app — execute as yourself, accessible to anyone. Copy the deployment URL.

### 3. Config
Copy `config.example.js` to `config.js`. Add your deployment URL and your GitHub Pages base URL:

```js
const FLOYD_CONFIG = {
  api_url: "https://script.google.com/macros/s/YOUR_ID/exec",
  base_url: "https://yourusername.github.io/floyd"
};
```

### 4. GitHub Pages
Push all files except `config.js` to a GitHub repo. Enable GitHub Pages from the main branch. Upload `config.js` directly — it is gitignored so it won't be committed.

### 5. Install as PWA
Open your GitHub Pages URL in Chrome on Android or Safari on iOS. Add to home screen.

---

## CONFIG Sheet — Key Settings

| Key | Description |
|---|---|
| `owner_id` | Lowercase identifier used in logs |
| `owner_name` | Your full name |
| `owner_birthday` | For Days Alive calculation (YYYY-MM-DD) |
| `partner_id` | Partner's lowercase identifier |
| `partner_name` | Partner's display name |
| `home_lat` / `home_lon` | Home coordinates |
| `home_radius_km` | Within this distance = home mode |
| `home_mode` | Mode name for home location |
| `accent_color` | Dashboard accent colour (hex) |
| `voice_lang` | Speech recognition language code |

---

## Dashboard Modes

Floyd automatically switches modes based on GPS location:
- **Home mode** — within `home_radius_km` of home coordinates
- **Second space** — within `second_space_radius_km`
- **Default/travel** — everywhere else

Each mode has its own theme (background, card, label, text colours) configured in CONFIG.

---

## Adding Dashboard Cards

Add a row to `DISPLAY_CONFIG`:

| Key | Modes | Condition | Label | Priority | Editable | Edit_Key |
|---|---|---|---|---|---|---|
| `my_key` | `all` | `always` | My Label | `5` | `true` | `my_key` |

- `Modes`: `all`, or comma-separated mode names e.g. `van,tuliptown`
- `Condition`: `always`, `partner_status=home`, `partner_status=working`
- `Editable`: `true` shows an edit button on the card
- `Edit_Key`: the SYSTEM_STATE key to update when the edit button is tapped

---

## Session Launcher

Open the Context Builder and configure a session:

1. **Prompt** — select from your PROMPTS sheet
2. **Query** — optional free-text question for the AI
3. **Person / Tags / Date Range** — filter the log data included
4. **Include** — toggle Identity and Current State
5. **Target AI** — select Claude, ChatGPT, Gemini, or DeepSeek
6. Tap **🚀 Launch** — context copies to clipboard, AI opens

The AI ends every session with a Floyd import link. Tap it to write entries back.

---

## Deep Links

Pre-configure sessions as tappable links:

```
/context.html?prompt=daily_checkin&ai=claude&date_preset=today&launch=true
```

Parameters: `prompt`, `query`, `ai`, `person`, `tags`, `date_preset`, `include_identity`, `include_state`, `launch`

---

## POST Handlers

| Key | Action |
|---|---|
| `import_entries` | Import JSON array to PERSONAL_LOG |
| `cycle_reset` | Log new partner cycle start |
| `log_maintenance` | Bulk retag / delete / dedupe PERSONAL_LOG |
| `prompt_update` | Write prompt text to PROMPTS sheet |
| `task_update` | Create / complete / update TASKS |
| `session_log` | Write session record to AI_SESSIONS |
| Any other key | Update SYSTEM_STATE + promote to PERSONAL_LOG |

---

## Tag Value Formats

| Tag | Format | Example |
|---|---|---|
| `#mood` | N/10 word | `7/10 calm` |
| `#sleep` | Nhrs quality | `7hrs good` |
| `#energy` | N/10 word | `8/10 focused` |
| `#health` | Plain observation | `lower back tight` |
| `#note` | Freeform text | `had a good conversation with Esther` |
| `#idea` | One sentence | `add recurring task support` |
| `#relationship` | Plain observation | `stable` |
| `#balance` | Numeric string | `622.77` |

---

## Roadmap

- **T005** — Floyd self-updates `context.html` via GitHub API
- **T006** — Floyd self-updates Apps Script via Google Apps Script API
- **T007** — AI relay — sessions run inside Floyd, no clipboard

---

## Philosophy

Floyd is a personal tool, not a product. It is designed to be owned and modified by the person using it. The sheet is the source of truth. The code is just plumbing.

The AI is not the system. The AI is a session worker that reads the system, converses with you, and writes back what matters. When the session ends, the AI is gone. The data stays.
