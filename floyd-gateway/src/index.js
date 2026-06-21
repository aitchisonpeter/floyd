// Floyd Gateway — the single front door to the Apps Script backend.
//
// WHY THIS EXISTS (Phase 1 of the rebuild). Today every client (PWA, MCP, the
// other Workers) calls the Apps Script /exec URL directly, sharing one secret,
// with unauthenticated reads and no idempotency. That gives us: a leaked-PII read
// surface, a flag-day SPOF on the URL/secret, 7s cold reads that hammer the Apps
// Script quota, and duplicate writes (the 302→echo path can't be safely retried).
//
// The gateway fixes all of that in one place:
//   • AUTH on reads + writes  → closes the open-read PII leak.
//   • The real Apps Script write secret lives ONLY here (APPS_SCRIPT_SECRET).
//     Clients present a GATEWAY_TOKEN; the backend secret never ships to a browser.
//   • KV CACHE of the context packet → kills the 7s latency and the repeat
//     full-sheet reads that push Apps Script toward its daily quota.
//   • IDEMPOTENT writes (opt-in idempotency_key) → safe retries, no duplicates.
//   • STABLE URL → redeploying Apps Script no longer breaks six places; only this
//     one var (FLOYD_API_URL) changes.
//
// DROP-IN MIGRATION: a client points its FLOYD_API_URL at the gateway and sends
// the GATEWAY_TOKEN instead of the Apps Script secret. GET ?type=… and POST {…}
// keep the exact same shapes, so nothing else changes.
//
// Secrets (wrangler secret put):  GATEWAY_TOKEN, APPS_SCRIPT_SECRET
// Vars (wrangler.jsonc):          FLOYD_API_URL, CACHE_TTL
// Bindings:                       FLOYD_CACHE (KV namespace)
//
// STATUS: review-only draft — NOT deployed. See README before going live.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
};

// GET ?type=… values that are safe + worth caching (read-only, slow to build).
// Everything else passes through uncached.
const CACHEABLE_TYPES = new Set(["context", "dashboard", "system", "projects", "curiosity_read", "memory_read", "tags", "schema"]);

// Query params that must NOT affect the cache key (cache-busters / auth).
const VOLATILE_PARAMS = new Set(["t", "key", "token"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Unauthenticated liveness probe — no secrets, safe to expose for monitoring.
    if (url.pathname === "/health") return json({ ok: true, service: "floyd-gateway" });

    // ── AUTH — required on every data request ────────────────────────────────
    if (!authorized(request, url, env)) return json({ error: "Unauthorized" }, 401);

    try {
      if (request.method === "GET") return await handleGet(url, env, ctx);
      if (request.method === "POST") return await handlePost(request, env, ctx);
      return json({ error: "method not allowed" }, 405);
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  },
};

// Accept the gateway token from a Bearer header (preferred), or ?key= (GET) /
// body.token (POST) for drop-in compatibility with the existing clients.
function authorized(request, url, env) {
  const expected = env.GATEWAY_TOKEN;
  if (!expected) return false; // fail closed if misconfigured
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (bearer && safeEqual(bearer, expected)) return true;
  const qp = url.searchParams.get("key");
  if (qp && safeEqual(qp, expected)) return true;
  // POST body.token is checked in handlePost (body is read there); allow it through
  // to that path by signalling "maybe" only when there's a body to inspect.
  return request.method === "POST"; // re-validated against body.token in handlePost
}

// ── GET: cached read-through to Apps Script ──────────────────────────────────
async function handleGet(url, env, ctx) {
  const type = (url.searchParams.get("type") || "").trim();
  const cacheable = CACHEABLE_TYPES.has(type) && env.FLOYD_CACHE;
  const cacheKey = cacheable ? "ctx:" + cacheKeyFor(url) : null;

  if (cacheKey) {
    const hit = await env.FLOYD_CACHE.get(cacheKey);
    if (hit) return jsonRaw(hit, { "X-Cache": "HIT" });
  }

  const upstream = await floydGet(env, url.searchParams);
  const body = await upstream.text();

  if (cacheKey && upstream.ok) {
    const ttl = Math.max(60, parseInt(env.CACHE_TTL || "300", 10) || 300);
    // waitUntil so caching never delays the response
    ctx.waitUntil(env.FLOYD_CACHE.put(cacheKey, body, { expirationTtl: ttl }));
  }
  return jsonRaw(body, { "X-Cache": cacheKey ? "MISS" : "BYPASS" });
}

// Cache key = type + sorted non-volatile params (so &t=<now> cache-busters and
// auth never fragment or leak into the key).
function cacheKeyFor(url) {
  const parts = [];
  for (const [k, v] of [...url.searchParams.entries()].sort()) {
    if (VOLATILE_PARAMS.has(k)) continue;
    parts.push(k + "=" + v);
  }
  return parts.join("&");
}

// ── POST: idempotent write-through, with backend-secret injection ────────────
async function handlePost(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }

  // Re-validate auth against body.token if the header/query didn't already match.
  const auth = request.headers.get("authorization") || "";
  const headerOk = auth.toLowerCase().startsWith("bearer ") && safeEqual(auth.slice(7).trim(), env.GATEWAY_TOKEN || "");
  if (!headerOk && !safeEqual((body.token || "").toString(), env.GATEWAY_TOKEN || "")) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Idempotency: opt-in via Idempotency-Key header or body.idempotency_key.
  const idemKey = request.headers.get("idempotency-key") || body.idempotency_key || null;
  if (idemKey && env.FLOYD_CACHE) {
    const prior = await env.FLOYD_CACHE.get("idem:" + idemKey);
    if (prior) return jsonRaw(prior, { "X-Idempotent-Replay": "true" });
  }

  // Strip any client-supplied token and inject the REAL Apps Script secret here,
  // so the backend secret never leaves the gateway.
  const { token, idempotency_key, ...rest } = body;
  const upstream = await floydPost(env, { ...rest, token: env.APPS_SCRIPT_SECRET });
  const text = await upstream.text();

  if (upstream.ok) {
    // A successful write may change the context — bust the context cache so the
    // next read is fresh (the brief/checkin workers read it right after writing).
    if (env.FLOYD_CACHE) ctx.waitUntil(env.FLOYD_CACHE.delete("ctx:type=context"));
    if (idemKey && env.FLOYD_CACHE) {
      ctx.waitUntil(env.FLOYD_CACHE.put("idem:" + idemKey, text, { expirationTtl: 86400 }));
    }
  }
  return jsonRaw(text);
}

// ── Apps Script transport (follows the 302→echo redirect, like the other Workers) ─
function floydGet(env, searchParams) {
  const u = new URL(env.FLOYD_API_URL);
  for (const [k, v] of searchParams.entries()) {
    if (k === "key") continue; // never forward the gateway token upstream
    u.searchParams.set(k, v);
  }
  u.searchParams.set("t", Date.now().toString());
  return fetch(u, { redirect: "follow" });
}

function floydPost(env, payload) {
  return fetch(env.FLOYD_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "follow",
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...CORS } });

const jsonRaw = (text, extra = {}) =>
  new Response(text, { headers: { "content-type": "application/json", ...CORS, ...extra } });

// Constant-time-ish comparison to avoid leaking length/prefix via timing.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
