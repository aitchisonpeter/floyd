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
      const messages = Array.isArray(body.messages) ? body.messages : [];
      // Streaming path (body.stream:true) — replies flow token-by-token so the
      // check-in never feels frozen. Falls through to the JSON path otherwise, so
      // any non-streaming caller (and an old frontend) keeps working unchanged.
      if (body.stream) return chatStream(env, messages, ctx);

      const out = await chat(env, messages);
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
// Context is slow to fetch from Apps Script (~7s), so we cache it for 5 min and
// only pay that on a true cold miss. TWO layers:
//   L1 = Cache API — per-colo, sub-ms warm, but evicts unpredictably (this was
//        the "misses intermittently → occasional ~6s turn" symptom).
//   L2 = Workers KV — global + reliable (~tens of ms), backstops L1 evictions so
//        a conversation almost never re-hits Apps Script.
// On an L2 hit we repopulate L1 so the rest of the colo goes fast again.
const CTX_CACHE_KEY = "https://floyd-cache.internal/context";
const CTX_KV_KEY = "chat:context";
const CTX_TTL = 300; // seconds
const ctxResponse = (body) =>
  new Response(body, { headers: { "content-type": "application/json", "Cache-Control": "max-age=" + CTX_TTL } });

async function getContextCached(env) {
  const cache = caches.default;
  const l1 = await cache.match(CTX_CACHE_KEY);
  if (l1) return l1.json();

  if (env.FLOYD_CACHE) {
    const l2 = await env.FLOYD_CACHE.get(CTX_KV_KEY);
    if (l2) {
      await cache.put(CTX_CACHE_KEY, ctxResponse(l2)); // warm L1 for this colo
      return JSON.parse(l2);
    }
  }

  const data = await floydGet(env, "context");
  const body = JSON.stringify(data);
  await cache.put(CTX_CACHE_KEY, ctxResponse(body));
  if (env.FLOYD_CACHE) {
    await env.FLOYD_CACHE.put(CTX_KV_KEY, body, { expirationTtl: CTX_TTL }).catch(() => {});
  }
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
  const loggedSigs = loggedSignatures(messages);
  for (let round = 0; round < 8; round++) {
    const res = await callClaude(env, system, messages);
    if (res.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: res.content });
      const results = [];
      for (const block of res.content) {
        if (block.type === "tool_use") {
          const out = await runTool(env, block.name, block.input, actions, loggedSigs);
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

// ── streaming conversation loop (SSE) ────────────────────────────────────────
// Same tool-use loop as chat(), but each Claude round is streamed: text deltas
// are forwarded to the client the instant they arrive, and an `action` event is
// emitted right after each tool runs (drives the inline chips). Events:
//   {type:"text",   delta}     incremental assistant text
//   {type:"action", action}    a tool just ran (log/propose) — render a chip
//   {type:"done",   actions}   turn finished; full action list for de-dupe
//   {type:"error",  error}     something failed mid-turn
// Tools execute exactly once per turn (same as the JSON path). On failure we emit
// an error and stop — we never auto-retry, because a re-run would double-log.
function chatStream(env, history, ctx) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (obj) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

  (async () => {
    const actions = [];
    try {
      const context = await getContextCached(env);
      const system = buildSystem(context);
      const messages = history
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
        .map((m) => ({ role: m.role, content: String(m.content) }));
      if (messages.length === 0) messages.push({ role: "user", content: "(start the check-in)" });

      const loggedSigs = loggedSignatures(messages);
      for (let round = 0; round < 8; round++) {
        const { content, stop_reason } = await streamClaudeRound(env, system, messages, send);
        if (stop_reason === "tool_use") {
          messages.push({ role: "assistant", content });
          const results = [];
          for (const block of content) {
            if (block.type !== "tool_use") continue;
            const before = actions.length;
            const out = await runTool(env, block.name, block.input, actions, loggedSigs);
            for (let i = before; i < actions.length; i++) send({ type: "action", action: actions[i] });
            results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) });
          }
          messages.push({ role: "user", content: results });
          continue;
        }
        send({ type: "done", actions });
        if (ctx && actions.some((a) => a.kind === "log")) ctx.waitUntil(recordCheckin(env));
        return;
      }
      send({ type: "done", actions, note: "stopped after too many steps" });
    } catch (e) {
      send({ type: "error", error: e.message });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...CORS },
  });
}

// Stream one Claude turn. Forwards text deltas via `send`, assembles the full
// content blocks (incl. tool_use input from input_json_delta chunks) so the loop
// can run tools, and returns {content, stop_reason}.
async function streamClaudeRound(env, system, messages, send) {
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
      stream: true,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Anthropic ${res.status}: ${await res.text().catch(() => "")}`);

  const blocks = [];   // assembled content blocks, by index
  const jsonBuf = {};  // index → accumulated tool_use partial_json
  let stop_reason = null;

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue; // skip `event:` lines + blanks
      const ev = safeParse(line.slice(5).trim());
      if (!ev) continue;
      switch (ev.type) {
        case "content_block_start":
          blocks[ev.index] = { ...ev.content_block };
          if (ev.content_block.type === "tool_use") jsonBuf[ev.index] = "";
          break;
        case "content_block_delta":
          if (ev.delta.type === "text_delta") {
            blocks[ev.index].text = (blocks[ev.index].text || "") + ev.delta.text;
            send({ type: "text", delta: ev.delta.text });
          } else if (ev.delta.type === "input_json_delta") {
            jsonBuf[ev.index] += ev.delta.partial_json || "";
          }
          break;
        case "content_block_stop":
          if (jsonBuf[ev.index] != null) blocks[ev.index].input = safeParse(jsonBuf[ev.index]) || {};
          break;
        case "message_delta":
          if (ev.delta && ev.delta.stop_reason) stop_reason = ev.delta.stop_reason;
          break;
        case "error":
          throw new Error(ev.error?.message || "stream error");
      }
    }
  }
  return { content: blocks.filter(Boolean), stop_reason };
}

const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ── Re-log guard ─────────────────────────────────────────────────────────────
// The client sends text-only history, so tool_use blocks from earlier turns are
// gone by the time we rebuild messages — the model has no memory of what it
// already logged and will happily re-extract the whole conversation every turn.
// The client appends a "[logged: ...]" line to each stored assistant turn (built
// from the action chips); we parse those back into signatures and hard-drop any
// entry the conversation has already saved. Deterministic — not prompt-hope.
const sigOf = (tag, value) => `${(tag || "").trim()}|${(value || "").trim().toLowerCase()}`;

function loggedSignatures(messages) {
  const sigs = new Set();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content !== "string") continue;
    for (const match of m.content.matchAll(/\[logged: ([^\]]*)\]/g)) {
      for (const item of match[1].split(" ⋮ ")) {
        const sp = item.trim().indexOf(" ");
        if (sp > 0) sigs.add(sigOf(item.slice(0, sp), item.slice(sp + 1)));
      }
    }
  }
  return sigs;
}

async function runTool(env, name, input, actions, loggedSigs) {
  if (name === "floyd_log") {
    // Never let the conversation overwrite computed/financial state via promotion.
    const PROTECTED = ["#balance", "#odometer", "#cycle_phase", "#cycle_day"];
    const seen = loggedSigs || new Set();
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
    }).filter((e) => {
      const s = sigOf(e.tag, e.value);
      if (seen.has(s)) return false;
      seen.add(s); // also dedupes within this same turn
      return true;
    });
    if (!entries.length) return { ok: true, imported: 0, deduped: true, note: "already logged this conversation — do not retry" };
    const r = await floydPost(env, { key: "import_entries", entries });
    entries.forEach((e) => actions.push({ kind: "log", tag: e.tag, value: e.value, project: e.notes }));
    return { ok: true, imported: r.imported ?? entries.length, deduped: (input.entries || []).length - entries.length || undefined };
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
  const live = ctx.partner_cycle_live || {};
  // IDs included so #task_done entries can reference them; promoted task rows
  // carry their description in `key` (value is just 'open'), so prefer key.
  const tasks = (ctx.tasks || [])
    .filter((t) => String(t.status || "").toLowerCase() === "open")
    .map((t) => `- [${t.id}] ${t.key || t.value || t.task || JSON.stringify(t)}`)
    .slice(0, 25)
    .join("\n");

  // What Peter has actually logged lately — his OWN entries, not ingested phone
  // notifications — so the check-in opens already aware of his day, not cold.
  const recent = (ctx.logs || [])
    .filter((l) => l && l.tag && l.tag !== "#notification" && l.tag !== "#session")
    .slice(-18)
    .map((l) => {
      const who = l.person && String(l.person).toLowerCase() !== "peter" ? ` (${l.person})` : "";
      return `- ${l.tag} ${l.value}${who}`;
    })
    .join("\n");

  // Prefer the LIVE computed cycle over the stored SYSTEM_STATE mirror (which can lag).
  const cycleLine = live.current_phase
    ? `${live.current_phase} — day ${live.current_cycle_day}, ~${live.days_until_next}d to next`
    : (state.partner_cycle_phase || "?");

  // Presence is a first-class variable: alone = lean into solo/deep work; together = do less, protect the time.
  const pres = ctx.partner_presence || {};
  const presenceLine = pres.status === "working"
    ? `ALONE — ${meta.partner_name || "Esther"} is away${pres.location ? ` in ${pres.location}` : ""}${pres.away_until ? ` until ${pres.away_until}` : ""}. This is his solo/deep-work window — lean in, push the work that needs uninterrupted focus.`
    : `TOGETHER — ${meta.partner_name || "Esther"} is home. Do LESS: protect the time, keep it light, don't pile on tasks. Favor together-friendly threads.`;

  return `You are Floyd — ${meta.owner_name || "Peter"}'s digital mirror and thinking partner. Partner: ${meta.partner_name || "Esther"}.
Voice: warm but direct, present-moment, no AI pleasantries, no filler. You are talking, not writing essays.

WHO YOU'RE TALKING TO: ${meta.owner_name || "Peter"} is AuDHD. He holds many threads at once and talks about them interconnected — jumping between projects, people, health, money, ideas. Your job is to (1) hold a natural, flowing conversation, and (2) quietly untangle his stream into atomic entries filed against the right project/person/area.

HIS CURRENT STATE & PROJECTS (route details against these; ask if unsure which):
- active_project: ${state.active_project || "?"}
- focus_today: ${state.focus_today || state.focus_area || "?"}
- current_mode: ${state.current_mode || "?"}
- presence: ${presenceLine}
- ${meta.partner_name || "Esther"}'s cycle: ${cycleLine}
RECENT ENTRIES (what he's already logged lately — KNOW this; don't make him repeat it, build on it):
${recent || "(nothing logged recently)"}
OPEN TASKS:
${tasks || "(none)"}
BASELINE PATTERN:
${(state.last_pattern_summary || "").slice(0, 1200)}

HOW TO WORK:
- OPEN by reflecting where he actually is right now — reference something from RECENT ENTRIES or his focus_today — then ask one grounded question. Never open cold or generic.
- Converse naturally. React to what he says like a person who knows him.
- As distinct details surface, call floyd_log — split interconnected talk into SEPARATE atomic entries, each with the right tag/person/project. Don't wait for the end; log as you go.
- When something is ambiguous (which project? which person?), ASK a short clarifying question rather than guessing.
- Tags to use: #mood (N/10 word), #energy (N/10 word), #sleep (Nhrs quality), #health, #note, #idea, #task, #project, #van. Bare ratings like "8" → "8/10".
- CLOSE THE LOOP: when Peter says something is done/finished/sent that matches an OPEN TASK, log {tag:"#task_done", value:"<the task id in brackets, e.g. T032>", notes:"<short quote of what he said>"} — sheet rules then close that task automatically. Only use ids from OPEN TASKS; if no open task matches, it's just a #note. New commitments are #task; completions of existing ones are #task_done, never both.
- NEVER use #balance, #odometer, #cycle_phase, or #cycle_day — they drive critical computed/financial state. Money, plans, or anything you're unsure how to tag → #note. Only attach a specific tag when you're confident; default to #note.
- Do NOT double-log. Speech-to-text often repeats words; capture the underlying thing ONCE, not once per echo.
- ALREADY LOGGED IS LOGGED FOREVER: previous assistant turns may end with a "[logged: ...]" line — that is the permanent record of entries already saved to the sheet in this conversation. NEVER call floyd_log again for a fact recorded there (even reworded) unless its value genuinely changed. Restating an insight in conversation is fine; re-logging it is not.
- EVOLUTION: Floyd improves itself from these check-ins. Whenever you hear friction Floyd could fix or a feature it could add, call floyd_propose (propose only — he approves later). Prefer concrete sheet-driven changes (a rule, tag, card).
- WRAP-UP: When Peter signals he's finishing (e.g. "that's it", "done", "thanks", "gotta go"), close gracefully: a warm one-line sign-off plus a 1–2 line recap of what you captured, and make ONE final floyd_log call with a #session entry (value = a one-sentence summary of this check-in; notes = the key items logged). Then stop — no more questions.
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
