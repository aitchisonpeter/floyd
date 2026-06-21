# floyd-chat — conversational check-in agent (slice 2)

The brain behind `checkin.html`. You talk naturally (voice or text); Floyd holds
a real conversation, **splits your interconnected stream into atomic entries**
filed against the right project/person/area, and **proposes self-improvements**
it spots along the way. Runs Claude server-side with two tools.

## Flow
```
checkin.html ──POST /chat {token, messages[]}──▶ floyd-chat Worker
   loads your Floyd context → system prompt that knows your projects/people/tags
   → Claude (opus) converses + calls tools:
        floyd_log(entries)   → writes atomic entries to PERSONAL_LOG
        floyd_propose(...)   → appends to EVOLUTION_LOG (status: proposed)
   ◀── { reply, actions:[{kind:'log'|'propose', ...}] }   (UI shows inline chips)
```

Evolution is **propose → approve → apply**: Floyd only writes *proposals* to
`EVOLUTION_LOG`; nothing changes until you approve. (`EVOLUTION_LOG` is created
automatically on first proposal.)

## Setup
```bash
cd floyd-chat
wrangler secret put ANTHROPIC_API_KEY   # same Anthropic key as the brief worker
wrangler secret put FLOYD_TOKEN         # paste your API_SECRET (matches the Apps Script Script Property)
wrangler deploy
```
`FLOYD_API_URL` and `FLOYD_CHAT_MODEL` are set in `wrangler.jsonc`. Model defaults
to `claude-opus-4-8` (best at the interconnected parsing/routing); switch to
`claude-sonnet-4-6` there to cut cost.

## Frontend
`checkin.html` (repo root) reads `FLOYD_CONFIG.chat_url` (defaults to
`https://floyd-chat.<sub>.workers.dev`). Ship it with your usual
`wrangler pages deploy` so it lands at `floyd.tuliptown.ca/checkin.html`. The
`floyd-checkin` Worker's `checkin` push opens this page.

## Test
1. Deploy this Worker.
2. Open `https://floyd.tuliptown.ca/checkin.html` — Floyd should greet you with
   context. Talk (e.g. "slept 8 hours, mood's an 8, I want to set up the Alphabet
   Poop site and I keep forgetting to log gas"). Watch for green `✓` log chips and
   a gold `💡 proposed` chip, and check the entries land in PERSONAL_LOG.

## CORS
The Worker returns `Access-Control-Allow-Origin: *` so the PWA can call it
cross-origin. Auth is the `token` in the POST body (your `api_secret`).
