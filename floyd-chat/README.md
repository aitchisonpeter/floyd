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

## Streaming (default in the PWA)

`checkin.html` POSTs `{token, messages, stream:true}` and the Worker replies with
**Server-Sent Events** so the reply fills in token-by-token (never feels frozen):

```
data: {"type":"text","delta":"…"}      incremental assistant text
data: {"type":"action","action":{…}}   a tool just ran → render a chip
data: {"type":"done","actions":[…]}     turn finished
data: {"type":"error","error":"…"}      failed mid-turn (no auto-retry — would double-log)
```

Tools run exactly once per turn (same as the JSON path). Omit `stream` (or send
`stream:false`) to get the original one-shot `{reply, actions}` JSON — the
frontend auto-detects the response content-type and falls back, so deploy order
between the Worker and the Pages front-end doesn't matter.

## Context cache (KV-backed)

Apps Script context is slow (~7s). The Worker caches it for 5 min in **two
layers**: L1 = Cache API (per-colo, warm-fast but evicts unpredictably — the old
"occasional 6s turn"), L2 = the shared `FLOYD_CACHE` KV namespace (global +
reliable, key `chat:context`) backstopping L1. The KV binding is in
`wrangler.jsonc` (reuses the gateway's namespace; no new namespace to create).

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
`https://floyd-chat.<sub>.workers.dev`). Ship it with `./scripts/deploy-pages.sh`
(syncs repo root → `public/` → Cloudflare Pages) so it lands at
`floyd.tuliptown.ca/checkin.html`. The `floyd-checkin` Worker's `checkin` push
opens this page. Deploy the Worker first (or in any order — the frontend falls
back to the JSON path if it meets an older, non-streaming Worker).

## Test
1. Deploy this Worker.
2. Open `https://floyd.tuliptown.ca/checkin.html` — Floyd should greet you with
   context. Talk (e.g. "slept 8 hours, mood's an 8, I want to set up the Alphabet
   Poop site and I keep forgetting to log gas"). Watch for green `✓` log chips and
   a gold `💡 proposed` chip, and check the entries land in PERSONAL_LOG.

## CORS
The Worker returns `Access-Control-Allow-Origin: *` so the PWA can call it
cross-origin. Auth is the `token` in the POST body (your `api_secret`).
