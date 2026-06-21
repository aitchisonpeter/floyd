# floyd-gateway

**Status: review-only draft — not deployed.** Phase 1 of the FLOYD rebuild (see the
`floyd-rebuild-plan` memory). This Worker becomes the **single front door** to the
Apps Script backend. Read the audit rationale at the top of `src/index.js` before
deploying.

## What it does

| Problem today | Gateway fix |
|---|---|
| Reads are unauthenticated → context packet leaks PII (home GPS, finances) | **Auth required on every read + write** |
| One Apps Script secret shared by every client, in browser source | Real secret (`APPS_SCRIPT_SECRET`) lives **only here**; clients hold a separate `GATEWAY_TOKEN` |
| Context build is ~7s and re-reads every sheet 16×/day → Apps Script quota | **KV cache** of cacheable reads (`CACHE_TTL`, default 5 min) |
| 302→echo write path can't be safely retried → duplicate entries | **Idempotent writes** (opt-in `Idempotency-Key` / `idempotency_key`) |
| `/exec` URL hardcoded in 6 places → redeploy = flag-day | **Stable URL**; only `FLOYD_API_URL` here changes |

It is a **drop-in** proxy: `GET ?type=…` and `POST {…}` keep the exact same shapes
the clients already use. A client migrates by changing its base URL to the gateway
and swapping the Apps Script secret for the `GATEWAY_TOKEN`.

## Setup (when ready to go live)

```sh
cd floyd-gateway
wrangler kv namespace create FLOYD_CACHE      # paste the id into wrangler.jsonc
wrangler secret put GATEWAY_TOKEN             # a NEW token clients will present
wrangler secret put APPS_SCRIPT_SECRET        # the real Apps Script write token (floyd_…)
wrangler deploy
```

Smoke test:

```sh
GW=https://floyd-gateway.<account>.workers.dev
curl -s "$GW/health"                                            # {"ok":true,...}
curl -s "$GW/?type=context" -H "Authorization: Bearer <GATEWAY_TOKEN>" | head -c 200
curl -s "$GW/?type=context" -H "Authorization: Bearer wrong"    # {"error":"Unauthorized"}
```

## Migration order (low-risk, one client at a time)

1. Deploy the gateway; confirm cached reads + an authed write work.
2. Repoint the **MCP** and **mem-sync** envs (`FLOYD_API_URL` → gateway, secret → `GATEWAY_TOKEN`).
3. Repoint the **brief / checkin / chat** workers' `FLOYD_API_URL` + `FLOYD_TOKEN`.
4. Repoint the **PWA** (`config.js` `api_url` → gateway). Now no Apps Script secret
   ships to the browser — only the `GATEWAY_TOKEN`.
5. Repoint **Tasker**'s HTTP task.
6. Once everything is on the gateway, **lock the Apps Script `/exec` down** (or keep
   it as a documented break-glass path) so it's only reachable via the gateway.

## Hardening notes / open decisions

- **Browser token.** The PWA still ships *a* token (`GATEWAY_TOKEN`) in source. The
  clean fix is **Cloudflare Access** (Google SSO, allow only Peter's email) in front
  of the gateway + PWA, removing tokens from the browser entirely. Recommended before
  treating reads as truly private. The bearer-token path stays as the machine-client
  (MCP/Workers/Tasker) auth.
- **Idempotency is best-effort (KV).** The dedup record is written to KV before the
  response, but KV is eventually consistent, so a *sub-second* duplicate can still race
  through (verified in the smoke test). It reliably catches retries that arrive seconds+
  apart — the realistic blind-retry case. For a STRONG guarantee, key a Durable Object
  by `idemKey` instead; tracked as a follow-up.
- **Cache invalidation** is currently coarse: a successful write busts the whole
  `context` cache. Fine for one user. If staleness ever matters more, add per-type keys.
- **`/activate` & the project hub** stay on `floyd-checkin` (they're intentionally
  public); the gateway gives that worker a *privileged* read path so `activate_code`
  can finally be redacted from the public `projects` read.
