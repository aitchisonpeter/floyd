# floyd-gmail — email → Floyd log (Worker + Claude inline)

Phase 2 of the Gmail pipeline. Extends the calendar-ingestion pattern to email:
a cron Worker reads curated mail from the Apps Script `peek_gmail` route, asks
Claude to pull out concrete actionable items, and files them into Floyd through
the universal `entries[]` door. Mirrors `floyd-brief-worker`.

```
Gmail ──(label:Floyd)──▶ Apps Script peek_gmail ──▶ floyd-gmail Worker
                                                       │  KV dedup (gmail:<id>)
                                                       │  Claude extract (task/appt/bill/travel)
                                                       ▼
                                   Floyd entries[] door ──▶ #task→TASKS / #calendar→CALENDAR …
                                                       └──▶ one phone notification
```

## Why a curated label
Pointed at the raw inbox, Claude would burn tokens reading promos to find one
bill. The `Floyd` label (set up in Phase 1 via Gmail filters) keeps the input to
real signal. Override per-run with `?q=` for testing.

## Prerequisites
- Apps Script `peek_gmail` route deployed + `setupGmailAccess()` run — see
  `../DEPLOY_gmail.md`. (Verified live.)
- A `Floyd` Gmail label with routing filters sending real mail into it. Until it
  has traffic, smoke-test against the inbox with `?q=in:inbox`.

## Deploy
```bash
cd floyd-gmail
npm run deploy                                   # wrangler deploy
wrangler secret put ANTHROPIC_API_KEY            # paste the Anthropic key
wrangler secret put FLOYD_TOKEN                  # the shared api_secret (config.js)
```
`FLOYD_TOKEN` is the same `api_secret` used everywhere else — it is BOTH the POST
write token AND the `key` that gates the `peek_gmail` GET route.

## Triggers
- **Cron** (`wrangler.jsonc`): 11/15/19/23 UTC (~07/11/15/19 ET).
- **Manual**: `GET https://floyd-gmail.<acct>.workers.dev/?key=<FLOYD_TOKEN>`
  - `&dry=1` — extract + report, write nothing, don't mark seen (safe to repeat)
  - `&q=in:inbox` — override the query for a smoke test

## Behaviour notes
- **Dedup**: each handled thread is remembered in KV (`gmail:<thread_id>`, 90-day
  TTL) — including ones that yielded nothing — so mail is never re-processed.
- **Conservative**: items below confidence 0.6 are skipped (thread still marked
  seen). Most mail yields `kind:"none"`.
- **Tags**: task→`#task`, appointment→`#calendar`, bill→`#bill`, travel→`#travel`.
  Promotion to TASKS/CALENDAR is driven by Floyd's existing `LOG_RULES`; if a tag
  isn't yet mapped there it still lands in `PERSONAL_LOG`. Add a `LOG_RULES` row to
  promote new tags (e.g. `#bill` → task).
- **Notify**: one summary push per run via `floyd-checkin` `?type=notify`.

## First run
Recommended: `?dry=1&q=in:inbox` first, eyeball `would_write` / `extracted`, then
drop `dry` once the label is carrying real mail.
