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
// Local calendar date "YYYY-MM-DD" (America/Toronto) — en-CA already formats this way.
function localDateStr(now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
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
  const proposed = (proj.status || "").toLowerCase() === "proposed";
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
.banner{background:rgba(159,240,200,.14);border:1px solid rgba(159,240,200,.42);border-radius:14px;padding:11px 14px;margin:0 0 14px;font-size:14px}
.act{display:block;width:100%;margin:18px 0 4px;padding:16px;border:0;border-radius:16px;background:#1f9d63;color:#fff;font-size:17px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent}
.act:disabled{opacity:.7}
footer{opacity:.6;font-size:12.5px;text-align:center;margin-top:22px}
</style></head><body><div class="wrap">
<h1>${m.emoji || "🎯"} ${cap(proj.key)}${proposed ? "" : ` — día ${plan.dayN}`}</h1>
<p class="meta">Phase ${plan.phaseNum} of ${plan.phaseTotal} · ${proj.title || ""}</p>
${proposed ? `<div class="banner">🎯 Floyd drafted this coach for you — here's what you'd get. Tap activate to start the daily nudges.</div>` : ""}
<div class="focus"><b>${proposed ? "Phase 1 focus:" : "Today's focus:"}</b> ${plan.focus}<small>${plan.tip}</small></div>
${m.floor ? `<p class="floor">✅ Floor = ${m.floor}. That's the whole job on a hard day.</p>` : ""}
${links.map(card).join("\n")}
${proposed ? `<button id="act" class="act">✅ Activate this coach</button>
<script>document.getElementById('act').addEventListener('click',async function(){this.disabled=true;this.textContent='Activating…';try{const r=await fetch('/activate?p='+encodeURIComponent(${JSON.stringify(proj.key)})+'&code='+encodeURIComponent(${JSON.stringify(m.activate_code || "")}));const j=await r.json();this.textContent=(j&&j.ok)?'✅ Activated — first nudge tomorrow morning':'Could not activate — try again';}catch(e){this.textContent='Network error — try again';this.disabled=false;}});</script>` : ""}
<footer>Floyd · streak over perfection — just hit the floor.</footer>
</div></body></html>`;
}
// Evolution-loop proposals hub. Same visual language as the coach hub. The key
// is baked into the button URLs because loading this page already required it
// (dashboard-trust) — nothing more privileged than the page itself.
function proposalsHubHtml(open, token) {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const k = encodeURIComponent(token);
  const card = (p) => {
    const id = esc(p.id);
    const risk = String(p.risk || "tap").toLowerCase();
    const badge = risk === "auto" ? `<span class="pill auto">auto</span>` : `<span class="pill tap">needs your tap</span>`;
    return `<div class="card" data-id="${id}">
      <div class="head"><span class="op">${esc(p.type || "change")}</span>${badge}</div>
      <p class="sum">${esc(p.summary || "(no summary)")}</p>
      <div class="btns">
        <button class="apply" onclick="act('${id}','apply',this)">✅ Apply</button>
        <button class="reject" onclick="act('${id}','reject',this)">Dismiss</button>
      </div></div>`;
  };
  const body = open.length
    ? open.map(card).join("\n")
    : `<p class="empty">Nothing to review — Floyd had no proposals. 🌱</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Floyd · Proposals</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;padding:22px 16px calc(34px + env(safe-area-inset-bottom));font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#f2efe6;background:linear-gradient(160deg,#0f2027,#203a43 55%,#2c5364)}
.wrap{max-width:560px;margin:0 auto}
h1{font-size:22px;margin:0 0 2px}.lead{opacity:.8;font-size:14px;margin:0 0 16px}
.card{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:15px 16px;margin:12px 0}
.head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.op{font-size:12.5px;letter-spacing:.04em;text-transform:uppercase;opacity:.7}
.pill{margin-left:auto;font-size:12px;padding:3px 9px;border-radius:999px}
.pill.auto{background:rgba(159,240,200,.16);border:1px solid rgba(159,240,200,.4);color:#9ff0c8}
.pill.tap{background:rgba(255,217,160,.16);border:1px solid rgba(255,217,160,.4);color:#ffd9a0}
.sum{margin:0 0 12px;font-size:16px}
.btns{display:flex;gap:10px}
button{flex:1;padding:13px;border:0;border-radius:13px;font-size:15px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent}
.apply{background:#1f9d63;color:#fff}.reject{background:rgba(255,255,255,.10);color:#f2efe6}
button:disabled{opacity:.6}
.empty{opacity:.75;text-align:center;margin-top:40px}
footer{opacity:.6;font-size:12.5px;text-align:center;margin-top:22px}
</style></head><body><div class="wrap">
<h1>🌱 Floyd proposes</h1>
<p class="lead">Small changes Floyd suggests to how it works. Apply or dismiss — auto ones may already be live.</p>
${body}
<footer>Floyd · evolution loop · ${open.length} open</footer>
<script>
async function act(id,what,btn){
  const card=btn.closest('.card');card.querySelectorAll('button').forEach(b=>b.disabled=true);
  btn.textContent=what==='apply'?'Applying…':'Dismissing…';
  try{const r=await fetch('/proposals/'+what+'?id='+encodeURIComponent(id)+'&key=${k}');const j=await r.json();
    if(j&&j.ok){card.style.opacity=.45;btn.textContent=what==='apply'?'✅ Applied':'Dismissed';}
    else{btn.textContent='⚠ '+((j&&j.error)||'failed');card.querySelectorAll('button').forEach(b=>b.disabled=false);}}
  catch(e){btn.textContent='⚠ network';card.querySelectorAll('button').forEach(b=>b.disabled=false);}
}
</script>
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
    // Activate a proposed coach. Code-gated: the code travels only in the private
    // proposal link Floyd pushed to Peter, so possession = consent (no master token in the page).
    if (request.method === "GET" && url.pathname === "/activate") {
      const p = url.searchParams.get("p") || "";
      const code = url.searchParams.get("code") || "";
      const proj = (await getProjects(env)).find((x) => x.key === p || x.id === p);
      if (!proj) return Response.json({ ok: false, error: "not found" }, { status: 404 });
      if ((proj.status || "").toLowerCase() !== "proposed") return Response.json({ ok: true, already_active: true });
      if (!code || code !== (proj.meta || {}).activate_code) return Response.json({ ok: false, error: "bad code" }, { status: 403 });
      const meta = { ...(proj.meta || {}) };
      delete meta.activate_code;
      await floydPost(env, {
        key: "sheet_update", sheet: "PROJECTS",
        rows: [{ match_column: 1, match_value: proj.id, values: { "4": "active", "7": JSON.stringify(meta), "8": new Date().toISOString() } }],
      });
      return Response.json({ ok: true, activated: proj.key });
    }
    // Tappable confirm from the cushion alert. Logs that the cushions are in so
    // the record closes the loop. Open GET (single benign #weather row, same
    // trust level as /hub) — possession of the link = intent.
    if (request.method === "GET" && url.pathname === "/cushions-done") {
      await floydPost(env, {
        entries: [{ tag: "#weather", value: "patio cushions brought in (rain expected overnight)" }],
      }).catch(() => {});
      return new Response(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
          "<body style='margin:0;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;" +
          "font:18px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;background:linear-gradient(160deg,#0f2027,#203a43);color:#f2efe6'>" +
          "<div>✅ Logged — cushions in.<br><small style='opacity:.7'>Sleep easy. 🌧️</small></div>",
        { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
      );
    }
    // ── Evolution loop: proposals hub (SURFACE/ACT half; see EVOLUTION_LOOP.md) ──
    // Lists open proposals with apply/reject buttons. Key-gated (same trust level
    // as the dashboard) — opened from the authenticated dashboard's brief line, so
    // the master token isn't pushed in a notification. apply → Apps Script's
    // whitelist executor (auto:false = Peter's tap = consent for tap-gated ops).
    if (request.method === "GET" && url.pathname === "/proposals") {
      if (url.searchParams.get("key") !== env.FLOYD_TOKEN) return new Response("forbidden", { status: 403 });
      const all = (await floydGet(env, "proposals")).rows || [];
      const open = all.filter((r) => String(r.status || "").toLowerCase() === "proposed");
      return new Response(proposalsHubHtml(open, env.FLOYD_TOKEN), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (request.method === "GET" && (url.pathname === "/proposals/apply" || url.pathname === "/proposals/reject")) {
      if (url.searchParams.get("key") !== env.FLOYD_TOKEN) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
      const id = url.searchParams.get("id") || "";
      if (!id) return Response.json({ ok: false, error: "missing id" }, { status: 400 });
      if (url.pathname === "/proposals/reject") {
        await floydPost(env, { key: "sheet_update", sheet: "PROPOSALS",
          rows: [{ match_column: 1, match_value: id, values: { "8": "rejected", "9": new Date().toISOString() } }] });
        return Response.json({ ok: true, rejected: id });
      }
      const r = await floydPost(env, { key: "apply_proposal", id, auto: false }).catch((e) => ({ error: e.message }));
      return Response.json(r && r.ok ? { ok: true, applied: id, result: r.result } : { ok: false, error: (r && r.error) || "apply failed" });
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
    // The 03:00 & 04:00 UTC crons exist ONLY for the 11pm-local cushion check
    // (DST: 11pm Toronto = 03:00 UTC in EDT, 04:00 UTC in EST). maybeCushionAlert
    // self-gates to localHour===23, so exactly one of the two fires per night.
    // Keep the reminder/curiosity/project trio OFF these late wakes — no nagging
    // at bedtime, and no wasted LLM call at midnight.
    if (event.cron === "0 3 * * *" || event.cron === "0 4 * * *") {
      ctx.waitUntil(maybeCushionAlert(env));
      return;
    }
    ctx.waitUntil(Promise.allSettled([maybeRemind(env), maybeAskCuriosity(env), maybeProjectNudges(env)]));
  },
};

const stateMap = (arr) => { const m = {}; (arr || []).forEach((r) => { if (r && r.key) m[r.key] = r.value; }); return m; };

// A reminder can't fire within REMIND_COOLDOWN of the last one, and the judge is
// pointless before then. RECENT_CHECKIN: if he just checked in he isn't overdue —
// decide that for free. EVAL_INTERVAL: once we've asked the judge, don't re-ask
// every wake; this is the stamp the old code was missing (it only advanced
// last_reminder on a SEND, so quiet stretches paid for an LLM call every hour).
const REMIND_COOLDOWN_MS = 3 * 3600 * 1000;
const RECENT_CHECKIN_MS = 3 * 3600 * 1000;
const REMIND_EVAL_INTERVAL_MS = 2 * 3600 * 1000;

async function maybeRemind(env) {
  const ctx = await floydGet(env, "context");
  const st = stateMap(ctx.current_state);
  const now = new Date();

  // Cheap deterministic gates BEFORE the paid judge — quiet stretches cost nothing.
  // Hard cooldown — never nag, and never spend a call deciding to.
  if (now - (Date.parse(st.last_reminder) || 0) < REMIND_COOLDOWN_MS) return { skipped: "reminder_cooldown" };
  // Just checked in → not overdue by any rhythm; no judge needed.
  if (now - (Date.parse(st.last_checkin) || 0) < RECENT_CHECKIN_MS) return { skipped: "recent_checkin" };
  // Already asked the judge recently → don't re-ask every wake.
  if (now - (Date.parse(st.last_reminder_check) || 0) < REMIND_EVAL_INTERVAL_MS) return { skipped: "eval_cooldown" };

  // Stamp the evaluation itself (not just sends) so the eval-cooldown holds.
  await floydPost(env, { key: "last_reminder_check", value: now.toISOString() });

  const decision = await askShouldRemind(env, st, now);
  if (decision && decision.remind && decision.message) {
    await dispatch(env, { type: "checkin", msg: decision.message });
    await floydPost(env, { key: "last_reminder", value: now.toISOString() });
    return { reminded: true };
  }
  return { evaluated: true, remind: false };
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
      return sendJoin(env, { title: a.title || "Floyd", text: a.text || "", url: a.url });

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

    case "cushion_dryrun":
      // Pull the overnight forecast + decision, send nothing, write nothing.
      // Bypasses the 23:00/home gates so it's testable any time, anywhere.
      return maybeCushionAlert(env, { force: true, dry: true });

    case "cushion_run":
      // Force the real path now (forecast → write rollups → alert if it'll rain).
      // Honors the home gate + dedupe; only skips the 23:00 time gate.
      return maybeCushionAlert(env, { force: true });

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

// ── Tuliptown: overnight-rain → bring-in-the-cushions alert ──────────────────
// Fires at 11pm local (the late crons). LLM-free, deterministic. Every night it
// also records the overnight rain rollup + a WEATHER_LOG row (tracking), and only
// pushes a high-priority alert when rain is likely AND Peter is home. Cushions
// stay a manual job — this is just the reminder so they don't get rained on again.
async function maybeCushionAlert(env, opts = {}) {
  const now = new Date();
  if (!opts.force && localHour(now) !== 23) return { skipped: "not_2300_local", hour: localHour(now) };

  const ctx = await floydGet(env, "context");
  const st = stateMap(ctx.current_state);
  const cfg = ctx.config || {};

  const mode = (st.current_mode || "").toLowerCase();
  const homeMode = (cfg.home_mode || "tuliptown").toLowerCase();
  const atHome = mode === homeMode;

  const lat = parseFloat(cfg.home_lat), lon = parseFloat(cfg.home_lon);
  if (isNaN(lat) || isNaN(lon)) return { skipped: "no_coords" };

  const fc = await fetchOvernightRain(lat, lon, now);
  const probThr = parseFloat(cfg.rain_prob_threshold) || 50;
  const mmThr = parseFloat(cfg.rain_mm_threshold) || 1;
  const willRain = fc.prob >= probThr || fc.mm >= mmThr;
  const todayStr = localDateStr(now);

  if (opts.dry) {
    return { dry: true, atHome, mode, mm: +fc.mm.toFixed(1), prob: fc.prob, willRain, window: fc.window, thresholds: { probThr, mmThr } };
  }

  // Record the overnight rollup + a forecast row every night, rain or shine —
  // BEFORE the at-home gate, so tracking never silently dies in van mode.
  await floydPost(env, { key: "rain_overnight_mm", value: fc.mm.toFixed(1) });
  await floydPost(env, { key: "rain_prob_overnight", value: String(fc.prob) });
  await floydPost(env, { key: "last_weather_pull", value: now.toISOString() });
  await logWeatherForecastRow(env, fc, now);

  // Cushions only matter at home — no patio in the van / abroad.
  if (!atHome) return { skipped: "not_home", mode };

  if (!willRain) return { rain: false, mm: +fc.mm.toFixed(1), prob: fc.prob };
  if ((st.cushion_alert_last || "") === todayStr) return { rain: true, skipped: "already_alerted" };

  await sendJoin(env, {
    title: "🌧️ Rain overnight — bring in the cushions",
    text: `~${fc.mm.toFixed(1)}mm, ${fc.prob}% chance tonight. Patio cushions inside before bed. Tap when done.`,
    url: (env.SELF_URL || env.FLOYD_BASE_URL || "https://floyd-checkin.aitchisonpeter.workers.dev").replace(/\/$/, "") + "/cushions-done",
    priority: 2,
  });
  await floydPost(env, { key: "cushion_alert_last", value: todayStr });
  return { rain: true, alerted: true, mm: +fc.mm.toFixed(1), prob: fc.prob };
}

// Open-Meteo hourly precip over the overnight window (tonight 23:00 → tomorrow
// 09:00 local). Returns summed mm and the max hourly probability. No API key.
async function fetchOvernightRain(lat, lon, now) {
  const todayStr = localDateStr(now);
  const tomorrowStr = localDateStr(new Date(now.getTime() + 24 * 3600 * 1000));
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("longitude", String(lon));
  u.searchParams.set("hourly", "precipitation,precipitation_probability");
  u.searchParams.set("timezone", "America/Toronto");
  u.searchParams.set("forecast_days", "2");
  const r = await fetch(u);
  if (!r.ok) throw new Error("open-meteo " + r.status);
  const d = await r.json();
  const t = d.hourly?.time || [], pr = d.hourly?.precipitation || [], pp = d.hourly?.precipitation_probability || [];
  const start = `${todayStr}T23:00`, end = `${tomorrowStr}T09:00`;
  let mm = 0, prob = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] >= start && t[i] <= end) {
      mm += Number(pr[i]) || 0;
      prob = Math.max(prob, Number(pp[i]) || 0);
    }
  }
  return { mm, prob, window: `${start}..${end}` };
}

// Append a forecast row to WEATHER_LOG (time-series; always appends, no upsert).
async function logWeatherForecastRow(env, fc, now) {
  const forDate = localDateStr(new Date(now.getTime() + 24 * 3600 * 1000));
  return floydPost(env, {
    key: "sheet_update", sheet: "WEATHER_LOG",
    rows: [{ values: {
      "1": now.toISOString(), "2": "forecast", "3": forDate,
      "4": fc.mm.toFixed(1), "5": String(fc.prob),
      "11": "open-meteo/checkin", "12": "overnight 23:00-09:00 window",
    } }],
  });
}

async function sendJoin(env, { title, text, url, priority }) {
  const u = new URL(JOIN_API);
  u.searchParams.set("apikey", env.JOIN_API_KEY);
  u.searchParams.set("deviceId", env.JOIN_DEVICE_ID);
  if (title) u.searchParams.set("title", title);
  if (text) u.searchParams.set("text", text);
  if (url) u.searchParams.set("url", url);
  // High priority lets time-sensitive pushes (e.g. the bedtime cushion alert)
  // punch through the phone's quiet hours / DND.
  if (priority != null) u.searchParams.set("priority", String(priority));
  const res = await fetch(u, { method: "POST" });
  const body = await res.text();
  if (!res.ok) throw new Error(`Join HTTP ${res.status}: ${body}`);
  return JSON.parse(body || "{}");
}
