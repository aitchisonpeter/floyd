// Floyd nightly-brief Worker — runs on a Cloudflare cron trigger, reads the
// Floyd context, asks Claude for a grounded daily brief, and writes it back to
// SYSTEM_STATE. Fully server-side: no Mac, no app open.
//
// Secrets (wrangler secret put):  ANTHROPIC_API_KEY, FLOYD_TOKEN
// Vars (wrangler.jsonc):          FLOYD_API_URL, FLOYD_BRIEF_MODEL

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const STATE_KEYS = ["focus_today", "floyd_brief", "intentions_today", "energy_baseline"];

export default {
  // Cron trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBrief(env));
  },
  // Manual trigger for testing: GET /?key=<FLOYD_TOKEN>
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("key") !== env.FLOYD_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      return Response.json(await runBrief(env));
    } catch (e) {
      return new Response("error: " + e.message, { status: 500 });
    }
  },
};

async function runBrief(env) {
  const context = await floydGet(env, "context");
  const brief = await generateBrief(env, trimContext(context));

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
          "\n\nWrite: focus_today (ONE small achievable objective), floyd_brief (2-3 sentence grounded reflection), intentions_today (top 3 items joined with ' | '), and energy_baseline (7-day average of #energy ratings as 'N/10', or omit if none).",
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
