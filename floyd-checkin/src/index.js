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

// ── Sheet-driven project coach ───────────────────────────────────────────────
// A reusable primitive. Each row in the PROJECTS sheet (read via the `projects`
// route) is a coached goal. Once each morning Floyd pushes a nudge whose tap
// opens that project's link hub (GET /hub?p=<key>). All project specifics —
// phases, links, floor, nudge time, last_nudge throttle — live in the row's
// `meta` JSON (same convention as CALENDAR), so a NEW coach is one sheet row,
// no code change. Same Join bridge Floyd uses for messages/alarms.

async function getProjects(env) {
  const r = await floydGet(env, "projects");
  return (r.rows || []).map((row) => {
    let meta = {};
    try { meta = JSON.parse(row.meta || "{}"); } catch { meta = {}; }
    return { id: row.id, key: row.key, title: row.value, status: row.status, notes: row.notes, meta };
  });
}
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Pure function of (project meta, date) → day number + current phase focus.
function projectPlan(meta, now) {
  const start = Date.parse(meta.start);
  const phases = meta.phases || [];
  const notStarted = !isNaN(start) && now.getTime() < start;
  const base = isNaN(start) ? startOfLocalDay(now) : start;
  const dayN = Math.max(1, Math.floor((startOfLocalDay(now) - base) / 86400000) + 1);
  const idx = phases.findIndex((p) => now.getTime() < Date.parse(p.until));
  const done = idx < 0;
  const cur = done ? null : phases[idx];
  return {
    notStarted, dayN,
    phaseNum: done ? phases.length : idx + 1,
    phaseTotal: phases.length,
    focus: done ? "Goal reached — keep the streak" : (cur.focus || ""),
    tip: done ? "¡Buen trabajo! Keep going." : (cur.tip || ""),
  };
}

function projectHubUrl(env, key) {
  return (env.SELF_URL || env.FLOYD_BASE_URL || "https://floyd.tuliptown.ca").replace(/\/$/, "") +
    "/hub?p=" + encodeURIComponent(key);
}

// Local-day boundary (America/Toronto) as a UTC ms value, for day counting/throttle.
function startOfLocalDay(now) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce((o, x) => (o[x.type] = x.value, o), {});
  return Date.UTC(+p.year, +p.month - 1, +p.day);
}
function localHour(now) {
  return +new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour12: false, hour: "2-digit" }).format(now);
}

// Cron: once each morning, push a nudge for every active project that's due.
async function maybeProjectNudges(env) {
  const now = new Date();
  const today = startOfLocalDay(now);
  const out = [];
  for (const proj of await getProjects(env)) {
    if ((proj.status || "").toLowerCase() !== "active") continue;
    const m = proj.meta || {};
    const plan = projectPlan(m, now);
    if (plan.notStarted) { out.push({ key: proj.key, skipped: "not_started" }); continue; }
    const nudgeHour = parseInt((m.nudge_time || "08:00").split(":")[0], 10) || 8;
    if (localHour(now) < nudgeHour) { out.push({ key: proj.key, skipped: "before_time" }); continue; }
    const lastDay = m.last_nudge && !isNaN(Date.parse(m.last_nudge)) ? startOfLocalDay(new Date(m.last_nudge)) : 0;
    if (lastDay >= today) { out.push({ key: proj.key, skipped: "already_today" }); continue; }
    await pushProjectNudge(env, proj, plan);
    await stampLastNudge(env, proj, now);
    out.push({ key: proj.key, sent: true, dayN: plan.dayN });
  }
  return out;
}

async function pushProjectNudge(env, proj, plan) {
  const m = proj.meta || {};
  return sendJoin(env, {
    title: `${m.emoji || "🎯"} ${cap(proj.key)} — día ${plan.dayN}`,
    text: `Floor: ${m.floor || "your minimum"}. ${plan.focus}. Tap for today's links.`,
    url: projectHubUrl(env, proj.key),
  });
}

// Write last_nudge back into the row's meta JSON (PROJECTS cols: 7=meta, 8=updated).
async function stampLastNudge(env, proj, now) {
  const meta = { ...(proj.meta || {}), last_nudge: now.toISOString() };
  return floydPost(env, {
    key: "sheet_update", sheet: "PROJECTS",
    rows: [{ match_column: 1, match_value: proj.id, values: { "7": JSON.stringify(meta), "8": now.toISOString() } }],
  });
}

function projectHubHtml(proj, now) {
  const m = proj.meta || {};
  const plan = projectPlan(m, now);
  const links = m.links || [];
  const card = (l) =>
    `<a class="card" href="${l.url}" target="_blank" rel="noopener"><span class="emo">${l.emoji || "🔗"}</span><span class="txt"><b>${l.title || l.url}</b><small>${l.sub || ""}</small></span><span class="go">→</span></a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Floyd · ${cap(proj.key)}</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;padding:22px 16px calc(34px + env(safe-area-inset-bottom));font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#f2efe6;background:linear-gradient(160deg,#0f2027,#203a43 55%,#2c5364)}
.wrap{max-width:560px;margin:0 auto}
h1{font-size:22px;margin:0 0 2px}
.meta{opacity:.8;font-size:14px;margin:0 0 4px}
.focus{background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.16);border-radius:14px;padding:12px 14px;margin:14px 0 18px}
.focus b{color:#ffd9a0}.focus small{display:block;opacity:.85;margin-top:4px}
.floor{font-weight:700;color:#9ff0c8;margin:0 0 12px}
.card{display:flex;align-items:center;gap:14px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:15px 16px;margin:11px 0;text-decoration:none;color:inherit;-webkit-tap-highlight-color:transparent}
.card:active{transform:scale(.985);background:rgba(255,255,255,.13)}
.emo{font-size:26px;width:30px;text-align:center;flex:0 0 auto}
.txt{flex:1;min-width:0}.txt b{display:block;font-size:16px}.txt small{opacity:.78}
.go{opacity:.55;font-size:20px}
footer{opacity:.6;font-size:12.5px;text-align:center;margin-top:22px}
</style></head><body><div class="wrap">
<h1>${m.emoji || "🎯"} ${cap(proj.key)} — día ${plan.dayN}</h1>
<p class="meta">Phase ${plan.phaseNum} of ${plan.phaseTotal} · ${proj.title || ""}</p>
<div class="focus"><b>Today's focus:</b> ${plan.focus}<small>${plan.tip}</small></div>
${m.floor ? `<p class="floor">✅ Floor = ${m.floor}. That's the whole job on a hard day.</p>` : ""}
${links.map(card).join("\n")}
<footer>Floyd · streak over perfection — just hit the floor.</footer>
</div></body></html>`;
}
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Public project hub — the daily nudge opens this on tap. No token (no secrets here).
    // /hub?p=<key> renders any project; /spanish kept as a back-compat alias.
    if (request.method === "GET" && (url.pathname === "/hub" || url.pathname === "/spanish")) {
      const p = url.pathname === "/spanish" ? "spanish" : (url.searchParams.get("p") || "");
      const proj = (await getProjects(env)).find((x) => x.key === p || x.id === p);
      if (!proj) return new Response("project not found", { status: 404 });
      return new Response(projectHubHtml(proj, new Date()), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
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
    ctx.waitUntil(Promise.allSettled([maybeRemind(env), maybeAskCuriosity(env), maybeProjectNudges(env)]));
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

// Cron: a few times a day, push one open CURIOSITY question — Floyd's curiosity
// surfacing, server-side (replaces the old Mac timer). Throttled by
// last_curiosity_push so it asks roughly every few waking hours, never repeats
// the same question (rotates by asked_count), and goes quiet when the pool is empty.
const CURIOSITY_INTERVAL_MS = 3.5 * 3600 * 1000;

async function maybeAskCuriosity(env, force) {
  const ctx = await floydGet(env, "context");
  const st = stateMap(ctx.current_state);
  const now = new Date();
  if (!force) {
    if (now - (Date.parse(st.last_curiosity_push) || 0) < CURIOSITY_INTERVAL_MS) return { skipped: "cooldown" };
    // presence-gated: only when Peter was recently in the dashboard (reachable),
    // but not this very moment — the inline card prompt covers active sessions.
    const seenAgo = now - (Date.parse(st.last_seen) || 0);
    if (!(seenAgo > 5 * 60 * 1000 && seenAgo < 2 * 3600 * 1000)) return { skipped: "outside_presence_window", seenAgoMin: Math.round(seenAgo / 60000) };
  }
  const cur = await floydGet(env, "curiosity_read");
  const open = (cur.rows || []).filter((r) => (r.status || "") === "open");
  if (!open.length) return { skipped: "no_open_questions" };
  // prefer least-asked, then highest priority (lowest number)
  open.sort(
    (a, b) =>
      (Number(a.asked_count) || 0) - (Number(b.asked_count) || 0) ||
      (Number(a.priority) || 99) - (Number(b.priority) || 99)
  );
  const q = open[0];
  await dispatch(env, {
    type: "notify",
    title: "Floyd has a question 🐤",
    text: q.question + "  —  answer in Floyd → ⚙ Maintenance → Questions.",
  });
  // rotate: mark asked so the next push picks a different one
  await floydPost(env, {
    key: "sheet_update",
    sheet: "CURIOSITY",
    rows: [{ match_column: 1, match_value: q.id, values: { "9": String((Number(q.asked_count) || 0) + 1), "10": now.toISOString() } }],
  });
  await floydPost(env, { key: "last_curiosity_push", value: now.toISOString() });
  return { asked: q.id, question: q.question };
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
    case "ask_now": // manual trigger; &force=0 also exercises the presence/cooldown gate
      return maybeAskCuriosity(env, a.force !== "0" && a.force !== false);

    case "notify":
      return sendJoin(env, { title: a.title || "Floyd", text: a.text || "" });

    case "project": { // manual fire. &p=<key> picks the project; &force=1 skips the daily/time gates (pure send, no stamp).
      const projs = await getProjects(env);
      const want = a.p || a.project;
      const proj = (want && projs.find((x) => x.key === want || x.id === want)) ||
        projs.find((x) => (x.status || "").toLowerCase() === "active");
      if (!proj) throw new Error("no matching project");
      if (a.force === "1" || a.force === true) {
        return pushProjectNudge(env, proj, projectPlan(proj.meta || {}, new Date()));
      }
      return maybeProjectNudges(env);
    }

    case "spanish": // back-compat alias for the old Spanish-specific action
      return dispatch(env, { ...a, type: "project", p: a.p || "spanish" });

    case "checkin": {
      const link =
        a.url ||
        `${env.FLOYD_BASE_URL || "https://floyd.tuliptown.ca"}/checkin.html` +
          (a.id ? `?id=${encodeURIComponent(a.id)}` : "");
      return sendJoin(env, { title: "Floyd — check-in", text: a.msg || a.text || "Tap to check in", url: link });
    }

    case "remind_dryrun": {
      // Test the reminder judgment without sending anything.
      const ctx = await floydGet(env, "context");
      return askShouldRemind(env, stateMap(ctx.current_state), new Date());
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
