// Floyd nightly-brief Worker — runs on a Cloudflare cron trigger, reads the
// Floyd context, asks Claude for a grounded daily brief, and writes it back to
// SYSTEM_STATE. Fully server-side: no Mac, no app open.
//
// Secrets (wrangler secret put):  ANTHROPIC_API_KEY, FLOYD_TOKEN
// Vars (wrangler.jsonc):          FLOYD_API_URL, FLOYD_BRIEF_MODEL

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const STATE_KEYS = ["focus_today", "floyd_brief", "intentions_today", "energy_baseline"];

export default {
  // Cron trigger — nightly brief + top up curiosity pool + propose a coach if a new goal appeared
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.allSettled([runBrief(env), generateCuriosity(env), maybeProposeCoach(env)]));
  },
  // Manual trigger: GET /?key=<FLOYD_TOKEN>  (&task=curiosity | &task=propose to run just that part)
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("key") !== env.FLOYD_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      const task = url.searchParams.get("task");
      if (task === "curiosity") return Response.json(await generateCuriosity(env));
      if (task === "propose") return Response.json(await maybeProposeCoach(env));
      return Response.json(await runBrief(env));
    } catch (e) {
      return new Response("error: " + e.message, { status: 500 });
    }
  },
};

async function runBrief(env) {
  const context = await floydGet(env, "context");
  const trimmed = trimContext(context);
  trimmed.today_milestones = todaysMilestones(context); // deterministic, not left to the model
  const brief = await generateBrief(env, trimmed);

  const written = {};
  for (const key of STATE_KEYS) {
    const value = brief[key];
    if (value) written[key] = (await floydPost(env, { key, value })).status || "ok";
  }
  await floydPost(env, {
    key: "import_entries",
    entries: [{ tag: "#session", value: "Daily brief generated", ai: "claude_worker" }],
  });
  return { brief, written };
}

// Top up Floyd's curiosity pool: when open questions run low, ask Claude for new
// ones grounded in what Floyd knows (AI_MEMORY) and what Peter already answered
// (build follow-ups via parent_id), avoiding duplicates. This is the "generation"
// half of the curiosity engine — the rest (surfacing) lives in floyd-checkin.
const CURIOSITY_TARGET_OPEN = 6;
const CURIOSITY_MAX_PER_RUN = 5;

async function generateCuriosity(env) {
  const cur = await floydGet(env, "curiosity_read");
  const rows = cur.rows || [];
  const open = rows.filter((r) => (r.status || "") === "open");
  const need = Math.min(CURIOSITY_TARGET_OPEN - open.length, CURIOSITY_MAX_PER_RUN);
  if (need <= 0) return { skipped: "pool_full", open: open.length };

  const mem = await floydGet(env, "memory_read");
  const memory = (mem.rows || []).map((r) => ({ name: r.name, type: r.type, description: r.description }));
  const answered = rows
    .filter((r) => (r.status || "") === "answered")
    .map((r) => ({ id: r.id, question: r.question, answer: r.answer, topic: r.topic }));
  const existing = rows.map((r) => r.question).filter(Boolean);

  const gen = await generateQuestions(env, { need, memory, answered, existing });

  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 60);
  const seen = new Set(existing.map(norm));
  let maxN = rows.reduce((m, r) => { const x = /^Q(\d+)$/.exec(String(r.id || "")); return x ? Math.max(m, +x[1]) : m; }, 0);
  const now = new Date().toISOString();
  const toWrite = [];
  for (const g of gen || []) {
    if (!g || !g.question || seen.has(norm(g.question))) continue;
    seen.add(norm(g.question));
    const id = "Q" + String(++maxN).padStart(3, "0");
    toWrite.push({
      match_column: 1,
      match_value: id,
      values: {
        "1": id, "2": g.question, "3": g.topic || "general", "4": g.why || "",
        "5": "open", "6": String(g.priority || 3), "8": g.parent_id || "",
        "9": "0", "11": now, "12": "floyd_generated",
      },
    });
  }
  if (!toWrite.length) return { skipped: "nothing_new", open: open.length };
  await floydPost(env, { key: "sheet_update", sheet: "CURIOSITY", rows: toWrite });
  return { generated: toWrite.length, ids: toWrite.map((r) => r.values["1"]), open_before: open.length };
}

const CURIOSITY_SYSTEM = `You are Floyd — Peter's digital mirror, in a deliberately curious "toddler" phase. You generate genuinely curious questions to learn about Peter: who he is, what matters to him, how he works, his health, his relationship with Esther, his history, his projects. Voice: warm, direct, present, no fluff. Each question is ONE clear ask a person can answer in a sentence or two. Avoid anything already asked. Prefer questions that fill real gaps in what you know, and build follow-ups on what he has already answered.`;

async function generateQuestions(env, { need, memory, answered, existing }) {
  const prompt =
    `Generate ${need} NEW curiosity questions for Floyd to ask Peter.\n\n` +
    `What Floyd already knows (memory summaries):\n${JSON.stringify(memory)}\n\n` +
    `Questions Peter has ALREADY ANSWERED (build follow-ups on these where natural — set parent_id to the answered question's id):\n${JSON.stringify(answered)}\n\n` +
    `Questions already in the pool (do NOT duplicate or rephrase these):\n${JSON.stringify(existing)}\n\n` +
    `For each new question give: question, topic (one word: values/esther/health/history/floyd/work/rhythm/general), why (what answering it would let Floyd understand — purposeful), priority (1=high..5=low), and parent_id ONLY if it's a follow-up to an answered question. Mix a couple of follow-ups with fresh gaps.`;

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: env.CURIOSITY_MODEL || "claude-sonnet-4-6",
      max_tokens: 1024,
      system: CURIOSITY_SYSTEM,
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              questions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    question: { type: "string" },
                    topic: { type: "string" },
                    why: { type: "string" },
                    priority: { type: "integer" },
                    parent_id: { type: "string" },
                  },
                  required: ["question", "topic", "why", "priority"],
                  additionalProperties: false,
                },
              },
            },
            required: ["questions"],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content.find((b) => b.type === "text") || {}).text || "{}";
  return JSON.parse(text).questions || [];
}

// ── Proactive coach proposals ────────────────────────────────────────────────
// Notices when Peter logs a NEW coachable goal that isn't yet a PROJECTS row,
// asks Claude to draft a full coach (phases, links, floor), writes it as a
// `proposed` row, and pushes a tappable proposal. Peter activates with one tap on
// the hub (code-gated /activate in floyd-checkin) — only then do nudges start.
// Mirrors the curiosity engine: this worker GENERATES, floyd-checkin SURFACES/ACTS.
const localDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

async function maybeProposeCoach(env) {
  const projects = await floydGet(env, "projects");
  const existing = (projects.rows || []).map((r) => ({ key: r.key, status: r.status, goal: r.value }));
  const ctx = await floydGet(env, "context");
  const logs = (Array.isArray(ctx.logs) ? ctx.logs : [])
    .filter((l) => (l.tag ?? l.Tag) !== "#notification")
    .slice(-40)
    .map((l) => ({ tag: l.tag ?? l.Tag, value: l.value ?? l.Value, notes: l.notes ?? l.Notes }));

  const draft = await draftCoachProposal(env, { logs, existing, today: localDate() });
  if (!draft || !draft.propose || !draft.key) return { skipped: (draft && draft.reason) || "no_candidate" };
  if (existing.some((e) => String(e.key).toLowerCase() === String(draft.key).toLowerCase()))
    return { skipped: "already_exists", key: draft.key };

  const code = Math.random().toString(36).slice(2, 8);
  const meta = {
    start: draft.start || localDate(), end: draft.end || "", emoji: draft.emoji || "🎯",
    nudge_time: draft.nudge_time || "08:00", floor: draft.floor || "",
    phases: draft.phases || [], links: draft.links || [], last_nudge: null, activate_code: code,
  };
  const id = "PRJ_" + draft.key;
  const now = new Date().toISOString();
  await floydPost(env, {
    key: "sheet_update", sheet: "PROJECTS",
    headers: ["id", "key", "value", "status", "context", "notes", "meta", "updated"],
    rows: [{ match_column: 1, match_value: id, values: {
      "1": id, "2": draft.key, "3": draft.goal || draft.key, "4": "proposed",
      "5": draft.key, "6": "Proposed coach — awaiting activation", "7": JSON.stringify(meta), "8": now } }],
  });

  const hub = (env.COACH_HUB_BASE || env.CHECKIN_URL || "https://floyd-checkin.aitchisonpeter.workers.dev") +
    "/hub?p=" + encodeURIComponent(draft.key);
  await floydPost(env, { key: "coach_proposal", value: `${meta.emoji} ${draft.goal} — tap to set up: ${hub}` });
  if (env.CHECKIN_URL) {
    const q = new URLSearchParams({ key: env.FLOYD_TOKEN, type: "notify",
      title: "Floyd drafted a coach 🎯", text: `${draft.goal} — tap to see the plan & activate`, url: hub });
    await fetch(`${env.CHECKIN_URL}/?${q}`).catch(() => {});
  }
  return { proposed: draft.key, hub, phases: meta.phases.length, links: meta.links.length };
}

const COACH_SYSTEM = `You are Floyd — Peter's digital mirror. You spot when Peter has logged a NEW personal GOAL or PROJECT that would benefit from a daily coach (a morning nudge + a links hub), and you draft it. Voice: direct, no fluff. Only propose when there is a clear, specific, ongoing goal that is NOT already in his projects list and is coachable with a daily habit. Skip vague wishes, one-off tasks, things already coached, and anything already 'proposed'. When you do propose, design a realistic plan: a daily floor (the smallest non-negotiable action, tuned to AUDHD — one tiny thing on a bad day), 2-5 dated phases from today to the goal date, and 3-6 genuinely useful REAL links (official sites/apps/tools) for the goal.`;

async function draftCoachProposal(env, { logs, existing, today }) {
  // Plain-JSON output (not json_schema): the phases+links nesting trips the
  // structured-output "schema too complex" limit, so we ask for JSON and parse it.
  const prompt =
    `Today is ${today} (America/Toronto).\n\n` +
    `Projects already coached or proposed (do NOT duplicate these keys or goals):\n${JSON.stringify(existing)}\n\n` +
    `Peter's recent log entries:\n${JSON.stringify(logs)}\n\n` +
    `If there is ONE clear new coachable goal here, draft it; otherwise return {"propose":false,"reason":"..."}.\n\n` +
    `Return ONLY a JSON object (no markdown, no prose) with exactly this shape when proposing:\n` +
    `{"propose":true,"key":"<short lowercase slug>","goal":"<one concrete sentence incl. target date if implied>",` +
    `"emoji":"<one emoji>","start":"${today}","end":"<YYYY-MM-DD>","nudge_time":"08:00",` +
    `"floor":"<smallest daily non-negotiable>",` +
    `"phases":[{"until":"<YYYY-MM-DD>","focus":"...","tip":"..."}],` +
    `"links":[{"emoji":"🔗","title":"...","sub":"...","url":"https://..."}]}\n` +
    `phases in date order (until = exclusive end of phase, last just after end). links: 3-6 real, useful URLs.`;

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: env.COACH_MODEL || "claude-sonnet-4-6",
      max_tokens: 1500,
      system: COACH_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let text = (data.content.find((b) => b.type === "text") || {}).text || "{}";
  const a = text.indexOf("{"), b = text.lastIndexOf("}"); // tolerate stray prose/fences
  if (a >= 0 && b > a) text = text.slice(a, b + 1);
  try { return JSON.parse(text); } catch { return { propose: false, reason: "unparseable" }; }
}

// Which personal milestones fall on TODAY (America/Toronto)? Computed in code
// so the brief can never "forget" a birthday again. Sources: config.owner_birthday
// and any #milestone log carrying a `date=MM-DD` token.
function todaysMilestones(ctx) {
  const todayMMDD = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" }).slice(5); // MM-DD
  const out = [];
  const cfg = ctx.config || {};
  const bday = cfg.owner_birthday;
  if (bday && String(bday).slice(5) === todayMMDD) {
    const age = new Date().getFullYear() - parseInt(String(bday).slice(0, 4), 10);
    out.push(`🎂 Today is ${cfg.owner_name || "Peter"}'s birthday (turning ${age}).`);
  }
  for (const l of Array.isArray(ctx.logs) ? ctx.logs : []) {
    if ((l.tag ?? l.Tag) !== "#milestone") continue;
    const m = `${l.value ?? l.Value ?? ""} ${l.notes ?? l.Notes ?? ""}`.match(/date=(\d{2})-(\d{2})/);
    if (m && `${m[1]}-${m[2]}` === todayMMDD && !/birthday/i.test(out.join(" "))) {
      out.push(String(l.value ?? l.Value ?? "milestone"));
    }
  }
  return [...new Set(out)];
}

// ── Floyd API ───────────────────────────────────────────────────────────────
async function floydGet(env, type) {
  const u = new URL(env.FLOYD_API_URL);
  u.searchParams.set("type", type);
  u.searchParams.set("t", Date.now().toString());
  const res = await fetch(u, { redirect: "follow" });
  if (!res.ok) throw new Error(`Floyd GET ${type}: HTTP ${res.status}`);
  return res.json();
}

async function floydPost(env, body) {
  // Workers fetch follows the Apps Script 302→echo redirect (POST→GET per spec).
  const res = await fetch(env.FLOYD_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, token: env.FLOYD_TOKEN }),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Floyd POST: HTTP ${res.status}`);
  const json = await res.json();
  if (json && json.error) throw new Error(`Floyd: ${json.error}`);
  return json;
}

// Keep the payload to Claude small and relevant.
function trimContext(ctx) {
  const out = {};
  for (const k of ["current_state", "tasks", "calendar", "partner_state", "_meta"]) {
    if (ctx[k]) out[k] = ctx[k];
  }
  if (Array.isArray(ctx.logs)) {
    out.recent_logs = ctx.logs.filter((l) => (l.tag ?? l.Tag) !== "#notification").slice(-25);
  }
  return out;
}

// ── Claude ──────────────────────────────────────────────────────────────────
const SYSTEM = `You are Floyd — Peter's digital mirror. Voice: direct, present-moment, no fluff, no AI pleasantries. Data over inference: treat the values in the context as facts.
Context on Peter: AUDHD (hyperfocus when engaged, paralysis when overloaded); one-goal interventions work; post-transition/travel periods are burnout-risk; his partner Esther's cycle phase affects tone.
Produce a brief for the day ahead from the supplied Floyd context. Be specific to today's data — do not invent anything the data does not support.`;

async function generateBrief(env, context) {
  const body = {
    model: env.FLOYD_BRIEF_MODEL || "claude-opus-4-8",
    max_tokens: 1024,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          "Floyd context (JSON):\n\n" +
          JSON.stringify(context) +
          "\n\nWrite: focus_today (ONE small achievable objective), floyd_brief (2-3 sentence grounded reflection), intentions_today (top 3 items joined with ' | '), and energy_baseline (7-day average of #energy ratings as 'N/10', or omit if none)." +
          " If today_milestones is non-empty, floyd_brief MUST open by warmly acknowledging them (e.g. wishing a happy birthday) before any tasks or health items.",
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            focus_today: { type: "string" },
            floyd_brief: { type: "string" },
            intentions_today: { type: "string" },
            energy_baseline: { type: "string" },
          },
          required: ["focus_today", "floyd_brief", "intentions_today"],
          additionalProperties: false,
        },
      },
    },
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const text = (data.content.find((b) => b.type === "text") || {}).text || "{}";
  return JSON.parse(text);
}
