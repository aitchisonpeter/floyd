# floyd-brief (Cloudflare Worker)

The always-on nightly brief. A Cloudflare cron Worker reads the Floyd context,
asks Claude for a grounded daily brief, and writes `focus_today` /
`floyd_brief` / `intentions_today` / `energy_baseline` back to SYSTEM_STATE.
Runs server-side on schedule — no Mac, no app open.

## What it does each run
1. `GET {FLOYD_API_URL}?type=context`
2. Trims to the relevant slices (state, tasks, calendar, partner, recent non-notification logs).
3. Calls the Anthropic Messages API (structured output → clean JSON).
4. Writes the 4 state keys + one `#session` log entry.

## Setup

```bash
cd floyd-brief-worker
npm install -g wrangler          # if not already installed
wrangler login                   # one-time browser auth (Cloudflare)

# Secrets (not stored in the repo):
wrangler secret put ANTHROPIC_API_KEY      # your Anthropic API key
wrangler secret put FLOYD_TOKEN            # = api_secret from the Floyd CONFIG sheet

wrangler deploy
```

`FLOYD_API_URL` and `FLOYD_BRIEF_MODEL` are already set in `wrangler.jsonc`.

## Schedule
`wrangler.jsonc` → `triggers.crons` is `"0 10 * * *"` (UTC) ≈ **06:00 Eastern (EDT)**.
Cloudflare cron is UTC and does not follow DST — in winter this lands at 05:00
local; change to `"0 11 * * *"` for 06:00 year-round. Edit and re-`deploy`.

## Test without waiting for the cron
After deploy, hit the Worker URL with the Floyd token:

```bash
curl "https://floyd-brief.<your-subdomain>.workers.dev/?key=<FLOYD_TOKEN>"
```

Returns the generated brief JSON and the write results. (The `?key` gate stops
anyone else triggering it.) You can also run `wrangler tail` to watch logs, or
trigger the cron locally with `wrangler dev --test-scheduled` then
`curl "http://localhost:8787/__scheduled"`.

## Model & cost
Defaults to `claude-opus-4-8`. The trimmed context is a few thousand tokens, so a
run costs roughly a few cents. To cut cost, set `"FLOYD_BRIEF_MODEL":
"claude-sonnet-4-6"` in `wrangler.jsonc` and re-deploy.

## Once this is live
Retire the app-dependent task so the brief isn't written twice: delete the
`floyd-daily-brief` entry in the Claude **Scheduled** sidebar.

## Secrets note
`ANTHROPIC_API_KEY` and `FLOYD_TOKEN` live in Cloudflare's secret store (set via
`wrangler secret put`), never in the repo. For local `wrangler dev`, put them in
`.dev.vars` (gitignored).
