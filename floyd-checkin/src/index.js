// Floyd action bridge (slice 1) — sends actions to your phone via the Join API.
//   notify  → native Join notification (title/text), no Tasker needed
//   checkin → native Join notification that opens the PWA modal (url), no Tasker
//   alarm   → Join push whose text is a command Tasker parses → Set Alarm
//
// Secrets:  JOIN_API_KEY, JOIN_DEVICE_ID, FLOYD_TOKEN
// Vars:     FLOYD_BASE_URL, FLOYD_API_URL
//
// Test (GET):  /?key=<FLOYD_TOKEN>&type=notify&title=Floyd&text=hello
//              /?key=<FLOYD_TOKEN>&type=alarm&time=14:30&label=Reactine
// Or POST JSON: { token, type, ... }

const JOIN_API = "https://joinjoaomgcd.appspot.com/_ah/api/messaging/v1/sendPush";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let action;
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (body.token !== env.FLOYD_TOKEN) return new Response("forbidden", { status: 403 });
      action = body;
    } else {
      if (url.searchParams.get("key") !== env.FLOYD_TOKEN) return new Response("forbidden", { status: 403 });
      action = Object.fromEntries(url.searchParams);
    }
    try {
      return Response.json({ ok: true, join: await dispatch(env, action) });
    } catch (e) {
      return new Response("error: " + e.message, { status: 500 });
    }
  },

  // Cron: adaptive check-in reminder. Wakes during waking hours; nudges only if
  // Peter is overdue vs his learned rhythm and hasn't been reminded recently.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(maybeRemind(env));
  },
};

const stateMap = (arr) => { const m = {}; (arr || []).forEach((r) => { if (r && r.key) m[r.key] = r.value; }); return m; };

async function maybeRemind(env) {
  const ctx = await floydGet(env, "context");
  const st = stateMap(ctx.current_state);
  const now = new Date();

  // Hard cooldown — never nag.
  if (now - (Date.parse(st.last_reminder) || 0) < 3 * 3600 * 1000) return;

  const decision = await askShouldRemind(env, st, now);
  if (decision && decision.remind && decision.message) {
    await dispatch(env, { type: "checkin", msg: decision.message });
    await floydPost(env, { key: "last_reminder", value: now.toISOString() });
  }
}

async function askShouldRemind(env, st, now) {
  const localNow = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit",
  }).format(now);

  const prompt = `You decide whether to gently remind Peter to check in with Floyd RIGHT NOW.
He wants to check in at least twice a day, more if natural.

Now (America/Toronto): ${localNow}
Last check-in: ${st.last_checkin || "unknown"}
Recent check-in timestamps, newest first (ISO/UTC): ${st.checkin_history || "none yet"}

Rules:
- LEARN his usual rhythm from the timestamps (typical times of day and count/day). Only remind if, by his own pattern, he'd normally have checked in by now and hasn't.
- Do NOT remind if he already checked in within his usual recent window, if it's outside reasonable waking hours, or if there's too little history to judge — in those cases remind=false.
- If reminding: one gentle, specific sentence in Floyd's voice (direct, warm, no fluff).
Return JSON only.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: env.REMINDER_MODEL || "claude-haiku-4-5",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { remind: { type: "boolean" }, message: { type: "string" } },
            required: ["remind", "message"], additionalProperties: false,
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const d = await res.json();
  try { return JSON.parse((d.content.find((b) => b.type === "text") || {}).text || "{}"); } catch { return null; }
}

async function floydGet(env, type) {
  const u = new URL(env.FLOYD_API_URL);
  u.searchParams.set("type", type);
  u.searchParams.set("t", Date.now().toString());
  const r = await fetch(u, { redirect: "follow" });
  if (!r.ok) throw new Error("Floyd GET " + r.status);
  return r.json();
}

async function floydPost(env, body) {
  const r = await fetch(env.FLOYD_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, token: env.FLOYD_TOKEN }),
    redirect: "follow",
  });
  if (!r.ok) throw new Error("Floyd POST " + r.status);
  const j = await r.json();
  if (j && j.error) throw new Error("Floyd: " + j.error);
  return j;
}

// Maps a Floyd action to a Join push.
async function dispatch(env, a) {
  switch (a.type) {
    case "notify":
      return sendJoin(env, { title: a.title || "Floyd", text: a.text || "" });

    case "checkin": {
      const link =
        a.url ||
        `${env.FLOYD_BASE_URL || "https://floyd.tuliptown.ca"}/checkin.html` +
          (a.id ? `?id=${encodeURIComponent(a.id)}` : "");
      return sendJoin(env, { title: "Floyd — check-in", text: a.msg || a.text || "Tap to check in", url: link });
    }

    case "alarm": {
      if (!a.time) throw new Error("alarm requires time (HH:MM)");
      // Tasker profile parses this exact prefix.
      const cmd = `floyd=alarm;time=${a.time};label=${(a.label || "Floyd").replace(/;/g, ",")}`;
      return sendJoin(env, { title: "Floyd alarm", text: cmd });
    }

    default:
      throw new Error("unknown action type: " + a.type);
  }
}

async function sendJoin(env, { title, text, url }) {
  const u = new URL(JOIN_API);
  u.searchParams.set("apikey", env.JOIN_API_KEY);
  u.searchParams.set("deviceId", env.JOIN_DEVICE_ID);
  if (title) u.searchParams.set("title", title);
  if (text) u.searchParams.set("text", text);
  if (url) u.searchParams.set("url", url);
  const res = await fetch(u, { method: "POST" });
  const body = await res.text();
  if (!res.ok) throw new Error(`Join HTTP ${res.status}: ${body}`);
  return JSON.parse(body || "{}");
}
