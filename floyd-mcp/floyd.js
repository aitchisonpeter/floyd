// Floyd API client — thin wrapper over the Google Apps Script web app.
// All network logic lives here so it can be tested independently of MCP wiring.
//
// Config comes from the environment (never hardcoded):
//   FLOYD_API_URL     — the floyd-gateway URL (preferred) or the Apps Script /exec URL
//   FLOYD_API_SECRET  — the bearer token: GATEWAY_TOKEN for the gateway, or the
//                       Apps Script write secret when pointed straight at /exec

const API_URL = process.env.FLOYD_API_URL;
const API_SECRET = process.env.FLOYD_API_SECRET || "";

if (!API_URL) {
  throw new Error("FLOYD_API_URL is not set. See floyd-mcp/.env.example");
}

// Bearer auth for the gateway (Phase 1), which requires a token on reads too.
// Harmless against Apps Script directly (it ignores the header), so the same
// client works whether FLOYD_API_URL points at the gateway or at /exec.
const authHeader = () => (API_SECRET ? { Authorization: `Bearer ${API_SECRET}` } : {});

// GET — Apps Script returns JSON directly. Node's fetch follows the 302→echo
// redirect correctly (downgrades POST→GET per spec), unlike curl's default.
async function apiGet(type, extra = {}) {
  const u = new URL(API_URL);
  u.searchParams.set("type", type);
  u.searchParams.set("t", Date.now().toString());
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, String(v));
  const res = await fetch(u, { headers: authHeader(), redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${type} failed: HTTP ${res.status}`);
  return res.json();
}

// POST — always injects the write token. Backend rejects with
// {error:'Unauthorized'} if the token is missing/wrong.
async function apiPost(body) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ ...body, token: API_SECRET }),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`POST failed: HTTP ${res.status}`);
  const json = await res.json();
  if (json && json.error) throw new Error(`Floyd: ${json.error}`);
  return json;
}

// ── Public surface ──────────────────────────────────────────────────────────

// Full assembled context packet (CONTEXT_SCHEMA-driven), optionally narrowed
// to a subset of top-level sections to keep payloads small.
export async function readContext(sections) {
  const data = await apiGet("context");
  if (Array.isArray(sections) && sections.length) {
    const out = {};
    for (const s of sections) if (s in data) out[s] = data[s];
    return out;
  }
  return data;
}

// Filtered view of recent PERSONAL_LOG entries. Note: the context route caps
// logs at 50 (CONTEXT_SCHEMA max_rows), so this filters that recent window.
export async function queryLog({ person, tag, limit = 50 } = {}) {
  const data = await apiGet("context");
  let logs = Array.isArray(data.logs) ? data.logs : [];
  if (person) logs = logs.filter(l => String(l.Person ?? l.person ?? "").toLowerCase() === person.toLowerCase());
  if (tag) logs = logs.filter(l => String(l.Tag ?? l.tag ?? "") === tag);
  // Newest first: the context `logs` array is oldest→newest, so take the tail and reverse.
  return logs.slice(-Math.max(0, limit)).reverse();
}

// Append atomic entries to PERSONAL_LOG (the write path). The backend fills
// in days_alive/timestamp/id and applies retention + qualify rules.
export async function appendEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("appendEntries requires a non-empty array");
  }
  return apiPost({ key: "import_entries", entries, ai: "claude_mcp" });
}

export const _config = { API_URL, hasSecret: Boolean(API_SECRET) };
