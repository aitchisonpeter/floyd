// Floyd conversational check-in agent.
// checkin.html talks to /chat here. The Worker holds the keys, loads Peter's
// life-context, runs Claude with two tools — floyd_log (parse the ramble into
// atomic entries) and floyd_propose (spot Floyd self-improvements) — executes
// the tool calls against the Floyd API, and returns Floyd's reply + a list of
// what it logged/proposed so the UI can show inline confirmations.
//
// Secrets:  ANTHROPIC_API_KEY, FLOYD_TOKEN
// Vars:     FLOYD_API_URL, FLOYD_CHAT_MODEL

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (body.token !== env.FLOYD_TOKEN) return json({ error: "forbidden" }, 403);

    try {
      const out = await chat(env, Array.isArray(body.messages) ? body.messages : []);
      // Record a check-in (async, doesn't delay the reply) when the turn logged something.
      if (ctx && out.actions && out.actions.some((a) => a.kind === "log")) {
        ctx.waitUntil(recordCheckin(env));
      }
      return json(out);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

// Mark that a real check-in happened: update last_checkin, and (debounced 30 min)
// prepend to a rolling checkin_history the reminder brain learns from.
async function recordCheckin(env) {
  try {
    const c = await getContextCached(env);
    const st = stateMap(c.current_state);
    const now = Date.now();
    const last = Date.parse(st.last_checkin) || 0;
    const writes = [floydPost(env, { key: "last_checkin", value: new Date(now).toISOString() })];
    if (now - last > 1800000) {
      const hist = String(st.checkin_history || "").split(",").map((s) => s.trim()).filter(Boolean);
      hist.unshift(new Date(now).toISOString());
      writes.push(floydPost(env, { key: "checkin_history", value: hist.slice(0, 40).join(",") }));
    }
    await Promise.all(writes);
  } catch (e) { /* best effort */ }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...CORS } });

// ── conversation loop ────────────────────────────────────────────────────────
// Context is slow to fetch from Apps Script (~7s). Cache it in Cloudflare's
// Cache API (shared across isolates in a colo, unlike a module global) for 5 min,
// so only the first turn of a conversation pays the cost.
const CTX_CACHE_KEY = "https://floyd-cache.internal/context";
async function getContextCached(env) {
  const cache = caches.default;
  const hit = await cache.match(CTX_CACHE_KEY);
  if (hit) return hit.json();
  const data = await floydGet(env, "context");
  await cache.put(
    CTX_CACHE_KEY,
    new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "Cache-Control": "max-age=300" } })
  );
  return data;
}

async function chat(env, history) {
  const ctx = await getContextCached(env);
  const system = buildSystem(ctx);

  // Client sends text-only turns; rebuild as Claude messages.
  const messages = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
    .map((m) => ({ role: m.role, content: String(m.content) }));
  if (messages.length === 0) messages.push({ role: "user", content: "(start the check-in)" });

  const actions = [];
  for (let round = 0; round < 8; round++) {
    const res = await callClaude(env, system, messages);
    if (res.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: res.content });
      const results = [];
      for (const block of res.content) {
        if (block.type === "tool_use") {
          const out = await runTool(env, block.name, block.input, actions);
          results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) });
        }
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    const text = (res.content.find((b) => b.type === "text") || {}).text || "";
    return { reply: text, actions };
  }
  return { reply: "(check-in stopped after too many steps)", actions };
}

async function runTool(env, name, input, actions) {
  if (name === "floyd_log") {
    // Never let the conversation overwrite computed/financial state via promotion.
    const PROTECTED = ["#balance", "#odometer", "#cycle_phase", "#cycle_day"];
    const entries = (input.entries || []).map((e) => {
      let tag = e.tag || "#note";
      let guard = "";
      if (PROTECTED.includes(tag)) { guard = `(model proposed ${tag}) `; tag = "#note"; }
      return {
        tag,
        value: e.value || "",
        person: e.person || undefined,
        notes: [guard, e.project ? `[${e.project}]` : "", e.notes || ""].filter(Boolean).join(" "),
        confidence: e.confidence,
        ai: "checkin",
      };
    });
    if (!entries.length) return { ok: false, error: "no entries" };
    const r = await floydPost(env, { key: "import_entries", entries });
    entries.forEach((e) => actions.push({ kind: "log", tag: e.tag, value: e.value, project: e.notes }));
    return { ok: true, imported: r.imported ?? entries.length };
  }

  if (name === "floyd_propose") {
    const id = "EV" + Date.now();
    await floydPost(env, {
      key: "sheet_update",
      sheet: "EVOLUTION_LOG",
      headers: ["id", "created", "source", "type", "description", "proposed_change", "impact", "effort", "status"],
      rows: [{
        values: {
          "1": id, "2": new Date().toISOString(), "3": "checkin", "4": input.type || "other",
          "5": input.description || "", "6": input.proposed_change || "",
          "7": input.impact || "", "8": input.effort || "", "9": "proposed",
        },
      }],
    });
    actions.push({ kind: "propose", description: input.description, type: input.type });
    return { ok: true, id };
  }

  return { ok: false, error: "unknown tool " + name };
}

// ── Claude ───────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "floyd_log",
    description:
      "Log atomic life entries parsed from what the user said. The user is AuDHD and talks about many interconnected things at once — SPLIT the stream into separate atomic entries, each routed to the right tag, person, and project/area. Call this as soon as a loggable detail emerges (don't wait for the end). One call can carry several entries.",
    input_schema: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tag: { type: "string", description: "Floyd tag, e.g. #mood #energy #sleep #idea #task #note #health #balance #project #van" },
              value: { type: "string", description: "the entry content, concise" },
              person: { type: "string", description: "who it's about; omit for the owner" },
              project: { type: "string", description: "project or life-area it belongs to, if identifiable" },
              notes: { type: "string" },
            },
            required: ["tag", "value"],
          },
        },
      },
      required: ["entries"],
    },
  },
  {
    name: "floyd_propose",
    description:
      "Propose a Floyd self-improvement whenever the conversation reveals friction Floyd could remove or a capability it could add. Floyd evolves by proposing config mutations (a new check-in rule, tag, dashboard card, route) or a feature spec. PROPOSE ONLY — the user approves before anything is applied. Prefer concrete, sheet-driven changes.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", description: "rule | tag | card | route | code | other" },
        description: { type: "string", description: "the improvement in plain language" },
        proposed_change: { type: "string", description: "concrete change — the exact sheet row to add, or a short spec" },
        impact: { type: "string" },
        effort: { type: "string" },
      },
      required: ["type", "description"],
    },
  },
];

function buildSystem(ctx) {
  const meta = ctx._meta || {};
  const state = stateMap(ctx.current_state);
  const tasks = (ctx.tasks || []).map((t) => `- ${t.value || t.task || JSON.stringify(t)}`).slice(0, 25).join("\n");

  return `You are Floyd — ${meta.owner_name || "Peter"}'s digital mirror and thinking partner. Partner: ${meta.partner_name || "Esther"}.
Voice: warm but direct, present-moment, no AI pleasantries, no filler. You are talking, not writing essays.

WHO YOU'RE TALKING TO: ${meta.owner_name || "Peter"} is AuDHD. He holds many threads at once and talks about them interconnected — jumping between projects, people, health, money, ideas. Your job is to (1) hold a natural, flowing conversation, and (2) quietly untangle his stream into atomic entries filed against the right project/person/area.

HIS CURRENT STATE & PROJECTS (route details against these; ask if unsure which):
- active_project: ${state.active_project || "?"}
- focus_area: ${state.focus_area || "?"}
- current_mode: ${state.current_mode || "?"}
- partner phase: ${state.partner_cycle_phase || "?"}
OPEN TASKS:
${tasks || "(none)"}
BASELINE PATTERN:
${(state.last_pattern_summary || "").slice(0, 1500)}

HOW TO WORK:
- Converse naturally. React to what he says like a person who knows him.
- As distinct details surface, call floyd_log — split interconnected talk into SEPARATE atomic entries, each with the right tag/person/project. Don't wait for the end; log as you go.
- When something is ambiguous (which project? which person?), ASK a short clarifying question rather than guessing.
- Tags to use: #mood (N/10 word), #energy (N/10 word), #sleep (Nhrs quality), #health, #note, #idea, #task, #project, #van. Bare ratings like "8" → "8/10".
- NEVER use #balance, #odometer, #cycle_phase, or #cycle_day — they drive critical computed/financial state. Money, plans, or anything you're unsure how to tag → #note. Only attach a specific tag when you're confident; default to #note.
- Do NOT double-log. Speech-to-text often repeats words; capture the underlying thing ONCE, not once per echo.
- EVOLUTION: Floyd improves itself from these check-ins. Whenever you hear friction Floyd could fix or a feature it could add, call floyd_propose (propose only — he approves later). Prefer concrete sheet-driven changes (a rule, tag, card).
- Keep replies short. End naturally; don't interrogate.`;
}

function stateMap(arr) {
  const m = {};
  (arr || []).forEach((r) => { if (r && r.key) m[r.key] = r.value; });
  return m;
}

async function callClaude(env, system, messages) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.FLOYD_CHAT_MODEL || "claude-opus-4-8",
      max_tokens: 1024,
      system,
      tools: TOOLS,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Floyd API ────────────────────────────────────────────────────────────────
async function floydGet(env, type) {
  const u = new URL(env.FLOYD_API_URL);
  u.searchParams.set("type", type);
  u.searchParams.set("t", Date.now().toString());
  const res = await fetch(u, { redirect: "follow" });
  if (!res.ok) throw new Error(`Floyd GET ${type}: ${res.status}`);
  return res.json();
}

async function floydPost(env, body) {
  const res = await fetch(env.FLOYD_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, token: env.FLOYD_TOKEN }),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Floyd POST: ${res.status}`);
  const j = await res.json();
  if (j && j.error) throw new Error("Floyd: " + j.error);
  return j;
}
