# Gmail hygiene routes (GmailApp, no OAuth client)

Extends the calendar-sync pattern to Gmail. The web app runs as `USER_DEPLOYING`,
so `GmailApp` reads and triages that account's mailbox with **no OAuth client** —
exactly the trick `CalendarApp` uses. Four token-gated GET routes let Floyd (and
Claude over the token API) survey senders, trash confirmed noise, and install
filters so the noise never comes back. `peek_gmail` is also the read door the
Phase-2 ingestion Worker will use to pull tasks / appointments / bills out of mail.

All routes are **token-gated** (`?key=<api_secret>`) because mail is sensitive and
the other read routes are open. `cleanup_gmail` is **dry-run unless `confirm=1`**,
so a stray prefetch can never delete mail.

## What changed (already in the repo)

- `apps-script/appsscript.json` — enabled the **Gmail advanced service** (needed for
  filter creation; `GmailApp` itself can't make filters).
- `apps-script/Code.js` — dispatch block for `peek_gmail` / `gmail_senders` /
  `cleanup_gmail` / `make_gmail_filter`, plus the functions and `setupGmailAccess()`.

## Deploy

```bash
cd apps-script
clasp push           # uploads Code.js + appsscript.json
```

Then in the Apps Script editor:

1. Run **`setupGmailAccess`** once. Approve the new Gmail scopes when prompted
   (this is the one-time consent — same as `setupCalendarSync` did for Calendar).
   It returns a small sender histogram so you can see it worked.
2. **Deploy → New deployment version** of the web app (scope changes need a fresh
   version). No URL change.

## The routes

`API` = your web-app `/exec` URL, `KEY` = `api_secret`.

```bash
# Survey the worst senders in the inbox (read-only) — builds the unsubscribe list
GET  $API?key=$KEY&type=gmail_senders&scan=300&top=40

# Peek recent inbox mail (read-only) — the Phase-2 ingestion door
GET  $API?key=$KEY&type=peek_gmail&q=in:inbox&max=25

# Trash noise — DRY-RUN first (no confirm)…
GET  $API?key=$KEY&type=cleanup_gmail&senders=noreply@r.groupon.com,ubereats@uber.com
# …then for real:
GET  $API?key=$KEY&type=cleanup_gmail&senders=noreply@r.groupon.com&confirm=1

# Stop a sender at the door, forever (action = trash | archive | label)
GET  $API?key=$KEY&type=make_gmail_filter&from=r.groupon.com&action=trash
GET  $API?key=$KEY&type=make_gmail_filter&from=dreamingspanish.com&action=label&label=Spanish
```

`senders` is comma-separated `from:` values (full address or bare domain). Pass a
raw Gmail query with `q=` instead for anything fancier; `max` caps a run (≤500).

## Verify

`gmail_senders` returns a ranked `top[]` of `{sender,count,latest}`. Run a
`cleanup_gmail` dry-run, confirm `would_trash` matches what you expect, then add
`&confirm=1`. `make_gmail_filter` returns a `filter_id`; new mail from that sender
then skips the inbox.

## Undo

- Filters: Gmail → Settings → Filters and Blocked Addresses → delete by hand.
- Trashed mail: recoverable from Trash for 30 days.
- Routes: remove the dispatch block + functions and redeploy, or roll back to a
  prior deployment version. Removing the advanced-service entry from the manifest
  drops the Gmail scopes on the next version.
