// Floyd nightly-brief Worker — runs on a Cloudflare cron trigger, reads the
// Floyd context, asks Claude for a grounded daily brief, and writes it back to
// SYSTEM_STATE. Fully server-side: no Mac, no app open.
//
// Secrets (wrangler secret put):  ANTHROPIC_API_KEY, FLOYD_TOKEN
// Vars (wrangler.jsonc):          FLOYD_API_URL, FLOYD_BRIEF_MODEL

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const STATE_KEYS = ["focus_today", "floyd_brief", "intentions_today", "energy_baseline"];

export default {
  // Cron trigger — pull weather FIRST (so the brief can read fresh solar/rain +
  // power_advisory from SYSTEM_STATE), then nightly brief + curiosity + coach.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await runWeather(env).catch((e) => console.warn("weather:", e.message));
      await runCamera(env).catch((e) => console.warn("camera:", e.message));
      await runFunnel(env).catch((e) => console.warn("funnel:", e.message));
      await runPeople(env).catch((e) => console.warn("people:", e.message));
      await runCorrespondence(env).catch((e) => console.warn("correspondence:", e.message));
      await Promise.allSettled([runBrief(env), generateCuriosity(env), maybeProposeCoach(env), maybeReflect(env), runOutreach(env)]);
    })());
  },
  // Manual trigger: GET /?key=<FLOYD_TOKEN>  (&task=curiosity | &task=propose | &task=reflect | &task=weather to run just that part)
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("key") !== env.FLOYD_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      const task = url.searchParams.get("task");
      if (task === "curiosity") return Response.json(await generateCuriosity(env));
      if (task === "propose") return Response.json(await maybeProposeCoach(env));
      if (task === "reflect") return Response.json(await maybeReflect(env));
      if (task === "weather") return Response.json(await runWeather(env));
      if (task === "camera") return Response.json(await runCamera(env));
      if (task === "funnel") return Response.json(await runFunnel(env));
      if (task === "outreach") return Response.json(await runOutreach(env));
      if (task === "people") return Response.json(await runPeople(env));
      if (task === "correspondence") return Response.json(await runCorrespondence(env));
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

  // Evolution loop, SURFACE half (spec §6). Append a TOKENLESS line — floyd_brief
  // lands in SYSTEM_STATE, which the open read routes expose, so no link/token here;
  // the dashboard builds the key-gated /proposals link client-side. Transparency is
  // non-negotiable: auto-applied changes are always echoed back too.
  const evo = await proposalsSurface(env);
  if (evo.line && brief.floyd_brief) brief.floyd_brief = brief.floyd_brief + "\n\n" + evo.line;

  const written = {};
  for (const key of STATE_KEYS) {
    const value = brief[key];
    if (value) written[key] = (await floydPost(env, { key, value })).status || "ok";
  }
  // Tokenless counters the dashboard reads to show/badge the Proposals hub.
  await floydPost(env, { key: "proposals_pending", value: String(evo.openTap) });
  await floydPost(env, { key: "proposals_summary", value: evo.summary || "" });
  await floydPost(env, {
    key: "import_entries",
    entries: [{ tag: "#session", value: "Daily brief generated", ai: "claude_worker" }],
  });
  return { brief, written };
}

// ── Tuliptown camera away-report ─────────────────────────────────────────────
// Pulls a one-line motion/clip summary from the Pi's floyd-api (cam_report) and
// writes it to SYSTEM_STATE, so the nightly brief + dashboard surface "what
// happened while away". Guarded: no-ops if PI_API_URL/FLOYD_API_SECRET unset.
async function runCamera(env) {
  if (!env.PI_API_URL || !env.FLOYD_API_SECRET) {
    return { skipped: "PI_API_URL / FLOYD_API_SECRET not set" };
  }
  const res = await fetch(`${env.PI_API_URL}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Floyd-Secret": env.FLOYD_API_SECRET },
    body: JSON.stringify({ action: "cam_report", args: ["24"] }),
  });
  if (!res.ok) throw new Error(`camera report: HTTP ${res.status}`);
  const json = await res.json();
  const summary = ((json && json.stdout) || "").trim();
  if (!summary) throw new Error("camera report empty");
  await floydPost(env, { key: "camera_24h", value: summary });
  await floydPost(env, { key: "last_camera_pull", value: new Date().toISOString() });
  return { camera_24h: summary };
}

// ── notthefinger funnel rollup ───────────────────────────────────────────────
// The notthefinger Worker's /t beacon writes daily view/click counters into the
// shared FLOYD_CACHE KV namespace (ntf:v:<day>, ntf:c:<offer>:<day>). Roll the
// last 7 days into one SYSTEM_STATE line so the brief + dashboard see traffic.
// Pipeline (LEADS sheet) flows into the brief separately via context.leads.
async function runFunnel(env) {
  if (!env.FLOYD_CACHE) return { skipped: "no FLOYD_CACHE binding" };
  const days = [];
  for (let i = 6; i >= 0; i--) {
    days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  }
  let views = 0;
  let viewsToday = 0;
  for (const d of days) {
    const v = parseInt((await env.FLOYD_CACHE.get(`ntf:v:${d}`)) || "0", 10);
    views += v;
    if (d === days[days.length - 1]) viewsToday = v;
  }
  const clicks = {};
  let clicksTotal = 0;
  const list = await env.FLOYD_CACHE.list({ prefix: "ntf:c:" });
  for (const k of list.keys) {
    const [, , offer, day] = k.name.split(":");
    if (!days.includes(day)) continue;
    const v = parseInt((await env.FLOYD_CACHE.get(k.name)) || "0", 10);
    clicks[offer] = (clicks[offer] || 0) + v;
    clicksTotal += v;
  }
  const detail = Object.keys(clicks).length
    ? ` (${Object.entries(clicks).map(([o, n]) => `${o} ${n}`).join(", ")})`
    : "";
  const summary = `7d: ${views} views · ${clicksTotal} Book clicks${detail} · today ${viewsToday} views`;
  await floydPost(env, { key: "ntf_traffic_7d", value: summary });
  await floydPost(env, { key: "last_funnel_pull", value: new Date().toISOString() });
  return { ntf_traffic_7d: summary };
}

// ── PEOPLE miner — relationship profiles from the streams Floyd already has ──
// Sources: #notification rows (WhatsApp/SMS/etc. via Tasker — sender in value,
// snippet in notes, package in meta) + gmail_senders. The Worker does ALL the
// arithmetic (counts, last_contact, channel mapping — and by mapping only real
// messaging packages, system spam like Play Protect never enters PEOPLE);
// Claude only classifies: relation, topics, living summary, lead_potential.
// Never auto-adds anyone to LEADS — flags 'maybe:<reason>' and pushes a nudge.
const MSG_PKG_CHANNEL = {
  "com.whatsapp": "whatsapp",
  "com.google.android.apps.messaging": "sms",
  "com.facebook.orca": "messenger",
  "org.thoughtcrime.securesms": "signal",
  "com.instagram.android": "instagram",
  "com.zhiliaoapp.musically": "tiktok",
};
// Sender names that are app chrome, not people.
const NOT_A_PERSON = /^(whatsapp|messages?|you|me)$/i;

// Nightly (T040): ask Apps Script to pull new Gmail threads for known people
// into the token-gated CORRESPONDENCE tab. GmailApp lives in Apps Script, so the
// Worker just triggers it; the capture itself is deterministic + privacy-gated.
async function runCorrespondence(env) {
  const url = `${env.FLOYD_API_URL}?type=capture_correspondence` +
    `&key=${encodeURIComponent(env.FLOYD_TOKEN)}&days=14&per_person=15`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) return { error: `http ${res.status}` };
  return await res.json();
}

async function runPeople(env) {
  const nowIso = new Date().toISOString();
  const cutoff = Date.now() - 36 * 3600000;

  // 1) Existing profiles
  const peopleRes = await floydGet(env, "people");
  const people = Array.isArray(peopleRes.rows) ? peopleRes.rows : [];

  // 2) Message notifications (last 50 #notification rows, windowed to 36h)
  const ctxRes = await fetch(`${env.FLOYD_API_URL}?type=context&tags=%23notification`, { redirect: "follow" });
  const ctx = ctxRes.ok ? await ctxRes.json() : {};
  const agg = {}; // name → {channels:Set, count, last, snippets[]}
  for (const l of (Array.isArray(ctx.logs) ? ctx.logs : [])) {
    const ts = Date.parse(l.timestamp || l.Timestamp || "");
    if (!ts || ts < cutoff) continue;
    let pkg = "";
    try { pkg = (JSON.parse(l.meta || l.Meta || "{}").package) || ""; } catch (e) {}
    const channel = MSG_PKG_CHANNEL[pkg];
    if (!channel) continue; // junk filter: only real messaging apps count
    const sender = String(l.value || l.Value || "").trim();
    if (!sender || NOT_A_PERSON.test(sender)) continue;
    const a = (agg[sender] = agg[sender] || { channels: new Set(), count: 0, last: "", snippets: [] });
    a.channels.add(channel);
    a.count++;
    const iso = new Date(ts).toISOString();
    if (iso > a.last) a.last = iso;
    const snip = String(l.notes || l.Notes || "").slice(0, 120);
    if (snip && a.snippets.length < 5) a.snippets.push(snip);
  }

  // 3) Gmail correspondents (2-day window; skip robots). BOTH directions:
  //    in:inbox counts who wrote Peter, in:sent counts who Peter wrote to (the
  //    gmail_senders route reports recipients for a sent query). Capturing the
  //    outbound half means a relationship Peter drives shows up in PEOPLE even
  //    when the other side is quiet. (T037)
  const ROBOT = /no-?reply|notification|newsletter|updates?@|info@|support@|mailer|donotreply/i;
  for (const dir of ["in:inbox", "in:sent"]) {
    try {
      const gq = encodeURIComponent(`${dir} newer_than:2d`);
      const gRes = await fetch(
        `${env.FLOYD_API_URL}?type=gmail_senders&key=${encodeURIComponent(env.FLOYD_TOKEN)}&q=${gq}&scan=100&top=25`,
        { redirect: "follow" }
      );
      const g = gRes.ok ? await gRes.json() : {};
      for (const s of g.top || []) {
        if (ROBOT.test(s.sender)) continue;
        const a = (agg[s.sender] = agg[s.sender] || { channels: new Set(), count: 0, last: "", snippets: [] });
        a.channels.add("email");
        a.count += s.count;
        if ((s.latest || "") > a.last) a.last = s.latest;
      }
    } catch (e) {
      console.warn(`people gmail ${dir}:`, e.message);
    }
  }

  const contacts = Object.entries(agg).map(([name, a]) => ({
    name, channels: [...a.channels], count: a.count, last: a.last, snippets: a.snippets,
  }));
  if (!contacts.length) return { skipped: "no message traffic in window" };

  // 4) Claude classifies; Worker keeps the numbers
  const upserts = await classifyPeople(env, people, contacts);

  const known = new Set(people.map((p) => p.id));
  let written = 0;
  const maybes = [];
  for (const u of (upserts || []).slice(0, 15)) {
    if (!u.id || !u.name) continue;
    const prior = people.find((p) => p.id === u.id) || {};
    const seen = contacts.find((c) =>
      c.name.toLowerCase() === u.name.toLowerCase() ||
      String(u.aliases || "").toLowerCase().includes(c.name.toLowerCase()));
    // in_funnel is sticky — the miner may never downgrade a funnel link.
    const lead = String(prior.lead_potential || "").startsWith("in_funnel")
      ? prior.lead_potential : (u.lead_potential || prior.lead_potential || "none");
    const values = {
      "1": u.id, "2": u.name,
      "3": u.aliases || prior.aliases || "",
      "4": u.relation || prior.relation || "unknown",
      "5": u.channels || [...new Set(String(prior.channels || "").split(",").filter(Boolean).concat(seen ? seen.channels : []))].join(","),
      "7": (seen && seen.last) || prior.last_contact || "",
      "8": String((parseInt(prior.msg_count, 10) || 0) + ((seen && seen.count) || 0)),
      "9": u.topics || prior.topics || "",
      "10": u.summary || prior.summary || "",
      "11": lead,
      "13": nowIso,
    };
    if (!known.has(u.id)) values["6"] = nowIso; // first_seen only on create
    await floydPost(env, { key: "sheet_update", sheet: "PEOPLE",
      rows: [{ match_column: 1, match_value: u.id, values }] });

    // PEOPLE_LOG trail (T040): append a dated snapshot per person this run — a
    // relationship TIMELINE, not just the living summary that gets overwritten.
    // No match_column, so every run appends (never edits) — queryable years on.
    await floydPost(env, { key: "sheet_update", sheet: "PEOPLE_LOG",
      headers: ["date", "person_id", "name", "relation", "msg_count", "snapshot"],
      rows: [{ values: {
        "1": nowIso, "2": u.id, "3": u.name,
        "4": values["4"], "5": values["8"],
        "6": String(u.summary || prior.summary || "").slice(0, 300),
      } }] }).catch((e) => console.warn("people_log:", e.message));
    written++;
    if (String(lead).startsWith("maybe")) maybes.push(`${u.name} (${String(lead).slice(6)})`);
  }

  // 5) Surface: top talkers + count, one nudge if the miner smells a lead
  const top = contacts.sort((a, b) => b.count - a.count).slice(0, 5)
    .map((c) => `${c.name} ${c.count}`).join(" · ");
  await floydPost(env, { key: "people_top", value: top });
  await floydPost(env, { key: "last_people_pull", value: nowIso });
  if (maybes.length) {
    await fetch(
      `${env.CHECKIN_URL}/?key=${encodeURIComponent(env.FLOYD_TOKEN)}` +
      `&type=notify&title=${encodeURIComponent("👥 Possible lead spotted")}` +
      `&text=${encodeURIComponent(maybes.join("; ") + " — say the word and it goes in the funnel")}`
    ).catch((e) => console.warn("people notify:", e.message));
  }
  return { contacts: contacts.length, written, top, maybes };
}

async function classifyPeople(env, people, contacts) {
  const known = people.map((p) => ({
    id: p.id, name: p.name, aliases: p.aliases || "", relation: p.relation || "",
    topics: p.topics || "", summary: p.summary || "", lead_potential: p.lead_potential || "",
  }));
  const body = {
    model: env.COACH_MODEL || "claude-sonnet-4-6",
    max_tokens: 1500,
    system: `You maintain Peter's PEOPLE sheet — living relationship profiles built from his real message traffic. Given KNOWN profiles and fresh CONTACTS (36h of senders + snippets), return upserts.
Rules: match contacts to known people via name/aliases BEFORE creating anyone (new id = 'P_' + snake_case name). relation ∈ partner|family|friend|colleague|client|lead|business|service|unknown — infer from evidence, keep existing unless evidence says otherwise. topics: ≤5 comma-separated themes actually present in snippets. summary: ≤2 sentences, a living profile (who they are + current thread), update don't rewrite. lead_potential: 'maybe:<short reason>' ONLY if snippets show a business/problem/project Peter could help with; otherwise keep existing value; never invent. Only return people with real signal this window — silence is fine. Skip app chrome, businesses' automated mail, and anyone with nothing new to say.`,
    messages: [{ role: "user", content: JSON.stringify({ KNOWN: known, CONTACTS: contacts }) }],
    output_config: {
      format: { type: "json_schema", schema: {
        type: "object",
        properties: { upserts: { type: "array", items: {
          type: "object",
          properties: {
            id: { type: "string" }, name: { type: "string" }, aliases: { type: "string" },
            relation: { type: "string" }, channels: { type: "string" }, topics: { type: "string" },
            summary: { type: "string" }, lead_potential: { type: "string" },
          },
          required: ["id", "name"], additionalProperties: false,
        } } },
        required: ["upserts"], additionalProperties: false,
      } },
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
  return (JSON.parse((data.content.find((b) => b.type === "text") || {}).text || "{}").upserts) || [];
}

// ── notthefinger outreach drafts (GENERATE half; Peter is the SEND half) ─────
// For each LEADS row at stage=lead with an email and no draft yet, Claude
// writes a short personal outreach email from the row's hook, drops it in
// Peter's Gmail Drafts via the token-gated make_gmail_draft route, and stamps
// the row (draft_id + next_action). One Join push per batch. Floyd never
// sends — approval IS pressing Send in Gmail.
const OUTREACH_SYSTEM = `You draft outreach emails AS Peter Aitchison — warm, direct, zero pitch, zero corporate. Peter runs notthefinger.tuliptown.ca: one hour ($150 CAD) where someone brings the stuck thing in their business and leaves knowing their next move.
Style contract: 2-4 sentences total. Open with the person's name and ONE true, specific line built from the supplied hook (never generic flattery). Then one plain sentence about what Peter's doing now, mentioning it costs $150 for the hour. End with the site notthefinger.tuliptown.ca — no hard ask, no "let me know!", no exclamation marks. Subject: short, lowercase-casual, specific to them. Sign off "Peter". Model line: "I've started doing something new: one hour, you bring the stuck thing, you leave knowing your next move."
Channel "linkedin" = a LinkedIn DM, not an email: 2-3 sentences, even more casual, no greeting-line formalities needed; the subject field is then just a short internal label (it is never sent). Avoid pronouns if the hook doesn't make them certain.
If the hook contains an explicit instruction about this message's PURPOSE (a thank-you, a referral ask, a specific offer tier), follow that instruction over the default shape.`;

async function runOutreach(env) {
  const context = await floydGet(env, "context");
  const leads = Array.isArray(context.leads) ? context.leads : [];
  const pending = leads.filter(
    (l) => (l.stage || "") === "lead" && (l.email || l.linkedin) && !l.draft_id
  ).slice(0, 5);
  if (!pending.length) return { drafted: 0 };

  const results = [];
  for (const lead of pending) {
    // No email → LinkedIn DM: draft lands in Peter's OWN Drafts, paste-ready,
    // with the profile URL at the bottom. Same review surface either way.
    const viaLinkedIn = !lead.email;
    const draft = await draftOutreach(env, lead, viaLinkedIn ? "linkedin" : "email");
    const made = await floydPost(env, {
      key: "make_gmail_draft",
      to: viaLinkedIn ? "self" : lead.email,
      subject: viaLinkedIn ? `LinkedIn → ${lead.name}: paste + send` : draft.subject,
      body: viaLinkedIn ? `${draft.body}\n\n———\npaste at: ${lead.linkedin}` : draft.body,
    });
    await floydPost(env, {
      key: "sheet_update", sheet: "LEADS",
      rows: [{ match_column: 1, match_value: lead.id, values: {
        "8": "review & send draft in Gmail",
        "11": new Date().toISOString(),
        "14": made.draft_id || "drafted",
      } }],
    });
    results.push({ id: lead.id, name: lead.name, to: lead.email });
  }

  await fetch(
    `${env.CHECKIN_URL}/?key=${encodeURIComponent(env.FLOYD_TOKEN)}` +
    `&type=notify&title=${encodeURIComponent("✉️ Outreach drafts ready")}` +
    `&text=${encodeURIComponent(results.length + " in Gmail Drafts: " + results.map((r) => r.name).join(", ") + " — review & send")}`
  ).catch((e) => console.warn("outreach notify:", e.message));

  return { drafted: results.length, results };
}

async function draftOutreach(env, lead, channel) {
  const body = {
    model: env.COACH_MODEL || "claude-sonnet-4-6",
    max_tokens: 500,
    system: OUTREACH_SYSTEM,
    messages: [{
      role: "user",
      content: "Draft the message for this contact (JSON):\n" + JSON.stringify({
        name: lead.name, hook: lead.hook || lead.notes || "",
        source: lead.source || "", offer: lead.offer || "discovery",
        channel: channel || "email",
      }),
    }],
    output_config: {
      format: { type: "json_schema", schema: {
        type: "object",
        properties: { subject: { type: "string" }, body: { type: "string" } },
        required: ["subject", "body"], additionalProperties: false,
      } },
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
  return JSON.parse((data.content.find((b) => b.type === "text") || {}).text || "{}");
}

// ── Tuliptown weather + solar/water tracking (GENERATE half) ─────────────────
// Pulls Open-Meteo daily forecast (no API key), writes today's solar/sunshine
// rollups + a 3-day solar outlook + a deterministic power_advisory to
// SYSTEM_STATE, logs a WEATHER_LOG row, and (if catchment_area_m2 is set in
// CONFIG) estimates catchable rainwater. The 11pm cushion alert lives in
// floyd-checkin (SURFACE half); this is the morning-facing projection.
async function runWeather(env) {
  const ctx = await floydGet(env, "context");
  const cfg = ctx.config || {};
  const lat = parseFloat(cfg.home_lat), lon = parseFloat(cfg.home_lon);
  if (isNaN(lat) || isNaN(lon)) return { skipped: "no_coords" };

  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("longitude", String(lon));
  u.searchParams.set("daily", "precipitation_sum,precipitation_probability_max,sunshine_duration,shortwave_radiation_sum,cloud_cover_mean,temperature_2m_min,temperature_2m_max");
  u.searchParams.set("timezone", "America/Toronto");
  u.searchParams.set("forecast_days", "4");
  const r = await fetch(u);
  if (!r.ok) throw new Error("open-meteo " + r.status);
  const dd = (await r.json()).daily || {};
  const days = dd.time || [];
  if (!days.length) return { skipped: "no_data" };

  const mj2kwh = (mj) => (Number(mj) || 0) / 3.6; // MJ/m² → kWh/m² (a solar-day index, not panel output)
  const sec2hr = (s) => (Number(s) || 0) / 3600;
  const dow = (s) => new Date(s + "T12:00").toLocaleDateString("en-US", { weekday: "short", timeZone: "America/Toronto" });

  const solarToday = mj2kwh(dd.shortwave_radiation_sum?.[0]);
  const sunToday = sec2hr(dd.sunshine_duration?.[0]);
  const rainToday = Number(dd.precipitation_sum?.[0]) || 0;

  // next-3-day outlook (indices 1..3)
  const outlook = [];
  for (let i = 1; i < Math.min(days.length, 4); i++) {
    outlook.push({ date: days[i], kwh: mj2kwh(dd.shortwave_radiation_sum?.[i]) });
  }
  const solarForecastStr = outlook.map((o) => `${dow(o.date)} ${o.kwh.toFixed(1)}`).join(" / ") + " kWh/m²";

  // Deterministic power advisory: flag when 2+ of the next 3 days are low-sun.
  const lowKwh = parseFloat(cfg.solar_low_kwh) || 3.0;
  const lowDays = outlook.filter((o) => o.kwh < lowKwh);
  const avg = outlook.length ? outlook.reduce((s, o) => s + o.kwh, 0) / outlook.length : 0;
  const advisory = lowDays.length >= 2
    ? `Low sun ${lowDays.map((o) => dow(o.date)).join("/")} (avg ${avg.toFixed(1)} kWh/m²) — go easy on power, charge devices today.`
    : "none";

  // Rainwater harvest estimate (needs catchment_area_m2 in CONFIG; skipped if blank).
  const area = parseFloat(cfg.catchment_area_m2);
  const coeff = parseFloat(cfg.runoff_coeff) || 0.85;
  const harvestNote = (!isNaN(area) && area > 0 && rainToday > 0)
    ? `~${Math.round(rainToday * area * coeff)}L catchable from ${rainToday.toFixed(1)}mm`
    : "";

  await floydPost(env, { key: "solar_today_kwh", value: solarToday.toFixed(1) });
  await floydPost(env, { key: "sunshine_hours_today", value: sunToday.toFixed(1) });
  await floydPost(env, { key: "solar_forecast_3d", value: solarForecastStr });
  await floydPost(env, { key: "power_advisory", value: advisory });
  await floydPost(env, { key: "last_weather_pull", value: new Date().toISOString() });

  await floydPost(env, {
    key: "sheet_update", sheet: "WEATHER_LOG",
    rows: [{ values: {
      "1": new Date().toISOString(), "2": "daily", "3": days[0],
      "4": rainToday.toFixed(1), "5": String(dd.precipitation_probability_max?.[0] ?? ""),
      "6": sunToday.toFixed(1), "7": (Number(dd.shortwave_radiation_sum?.[0]) || 0).toFixed(1),
      "8": String(dd.cloud_cover_mean?.[0] ?? ""), "9": String(dd.temperature_2m_min?.[0] ?? ""),
      "10": String(dd.temperature_2m_max?.[0] ?? ""), "11": "open-meteo/brief",
      "12": harvestNote || `solar index ${solarToday.toFixed(1)} kWh/m²`,
    } }],
  });

  return { solar_today_kwh: +solarToday.toFixed(1), sunshine_hours_today: +sunToday.toFixed(1), solar_forecast_3d: solarForecastStr, power_advisory: advisory, rain_today_mm: rainToday, harvestNote };
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

// ── Nightly reflection → structured proposals (the evolution-loop heartbeat) ──
// Reads recent life-context + the free-text idea stream + open proposals, asks
// Claude for 0–2 WHITELISTED mutation packets, writes each to PROPOSALS
// (status=proposed). risk=auto packets are applied immediately ONLY when
// REFLECT_AUTOAPPLY=on (off by default — watch a few days first; see spec §7).
// Mirrors the curiosity/coach engines: this worker GENERATES + PROPOSES; Apps
// Script's applyProposal EXECUTES; floyd-checkin's /proposals hub SURFACES taps.
const REFLECT_MAX_PER_DAY = 2;

// Whitelist handed to the model — kept in lockstep with applyProposal's executor.
const REFLECT_WHITELIST = `Allowed ops (compose ONLY these — anything else is refused by the executor):
- add_tag      {op:"add_tag", tag:"#fuel", keywords:["gas","fill up"], retention:"forever", action:"keep"}  (risk:auto)
- add_card     {op:"add_card", source_key:"<existing SYSTEM_STATE key>", title:"...", priority:50}            (risk:auto if the key is already tracked, else tap)
- track_metric {op:"track_metric", key:"water_level", seed:"", card:{title:"Water"}}                          (risk:tap — new surface)
- retire_flag  {op:"retire_flag", key:"<state key no longer useful>"}                                          (risk:auto)
- propose_coach{op:"propose_coach", key:"slug", goal:"one sentence", meta:{emoji,start,end,nudge_time,floor,phases,links}}  (risk:auto — activation is still Peter's tap)
- set_config   {op:"set_config", key:"...", value:"..."}                                                       (risk:tap ALWAYS)
NEVER touch protected tags (#balance/#odometer/#cycle_*) or any secret/token/api_key. No row deletes.`;

const REFLECT_SYSTEM = `You are Floyd — Peter's digital mirror — doing your nightly reflection. You look over the last while and decide whether one or two SMALL, concrete improvements to how Floyd works would genuinely help. You evolve Floyd by emitting whitelisted mutation packets that change his sheets (a new tag, a dashboard card for something already tracked, retiring a dead flag, a coach, etc.).
Bias HARD to silence: most nights earn NOTHING — return an empty list. Only propose when a clear, recurring signal in the data warrants it. Never re-propose something already open. At most ${REFLECT_MAX_PER_DAY} per night. Prefer the lowest-risk op that solves the real friction. ${REFLECT_WHITELIST}`;

const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
// Dedup signature: op + its primary target (so the same change can't pile up).
const opSignature = (p) => (p ? `${p.op}:${(p.tag || p.key || p.source_key || (p.card && p.card.source_key) || "").toString().toLowerCase()}` : "");

async function maybeReflect(env) {
  const props = await floydGet(env, "proposals").catch(() => ({ rows: [] }));
  const all = props.rows || [];
  const today = localDate();
  const createdToday = all.filter((r) => String(r.created || "").slice(0, 10) === today).length;
  if (createdToday >= REFLECT_MAX_PER_DAY) return { skipped: "daily_cap", createdToday };

  const open = all.filter((r) => String(r.status || "").toLowerCase() === "proposed");
  const ctx = await floydGet(env, "context");
  const st = stateMap(ctx.current_state);
  const logs = (Array.isArray(ctx.logs) ? ctx.logs : [])
    .filter((l) => (l.tag ?? l.Tag) !== "#notification" && (l.tag ?? l.Tag) !== "#session")
    .slice(-50)
    .map((l) => ({ tag: l.tag ?? l.Tag, value: l.value ?? l.Value, notes: l.notes ?? l.Notes }));
  const ev = await floydGet(env, "evolution_read").catch(() => ({ rows: [] }));
  const ideas = (ev.rows || [])
    .filter((r) => String(r.status || "").toLowerCase() === "proposed")
    .slice(-15)
    .map((r) => ({ type: r.type, description: r.description, change: r.proposed_change }));

  const room = REFLECT_MAX_PER_DAY - createdToday;
  // Deterministic health findings (HEALTH sheet, refreshed nightly by Apps
  // Script) — reflection reasons from verified facts, not from spotting
  // anomalies in noisy logs.
  const health = (Array.isArray(ctx.health) ? ctx.health : [])
    .filter((h) => h.status === "STALE" || h.status === "FAIL")
    .map((h) => ({ check: h.check, target: h.target, status: h.status, detail: h.detail }));
  const packets = await reflectProposals(env, {
    logs, ideas, today, room, state: st, health,
    openProposals: open.map((o) => ({ op: safeJson(o.packet)?.op, summary: o.summary })),
  });
  if (!packets || !packets.length) return { skipped: "nothing_earned", open: open.length };

  const written = [];
  const seen = new Set(open.map((o) => opSignature(safeJson(o.packet))));
  for (const p of packets) {
    if (written.length >= room) break;
    if (!p || !p.packet || !p.packet.op) continue;
    const sig = opSignature(p.packet);
    if (seen.has(sig)) continue; // dedup against open + this run
    seen.add(sig);

    const id = "P" + Date.now() + Math.floor(Math.random() * 100);
    const risk = p.risk === "auto" ? "auto" : "tap";
    await floydPost(env, {
      key: "sheet_update", sheet: "PROPOSALS",
      headers: ["id", "created", "source", "type", "summary", "packet", "risk", "status", "applied", "result"],
      rows: [{ match_column: 1, match_value: id, values: {
        "1": id, "2": new Date().toISOString(), "3": "reflection", "4": p.packet.op,
        "5": p.summary || "", "6": JSON.stringify(p.packet), "7": risk, "8": "proposed" } }],
    });

    let applied = false;
    // Auto-apply is OFF by default — flip REFLECT_AUTOAPPLY=on only once proposals read trustworthy.
    if (risk === "auto" && String(env.REFLECT_AUTOAPPLY || "").toLowerCase() === "on") {
      const r = await floydPost(env, { key: "apply_proposal", id, auto: true }).catch((e) => ({ error: e.message }));
      applied = !!(r && r.ok);
    }
    written.push({ id, op: p.packet.op, risk, applied });
  }
  return { proposed: written.length, items: written, autoapply: String(env.REFLECT_AUTOAPPLY || "off") };
}

// Read PROPOSALS and build the tokenless brief surfacing (open tap count + first
// summary) plus a transparency note for anything auto-applied today.
async function proposalsSurface(env) {
  try {
    const all = (await floydGet(env, "proposals")).rows || [];
    const today = localDate();
    // All open proposals are reviewable in the hub (incl. risk:auto ones while
    // auto-apply is OFF) — so the dashboard badge/count covers everything open.
    const open = all.filter((r) => String(r.status || "").toLowerCase() === "proposed");
    const autoToday = all.filter((r) =>
      String(r.status || "").toLowerCase() === "applied" &&
      String(r.risk || "").toLowerCase() === "auto" &&
      String(r.applied || "").slice(0, 10) === today);
    const summary = open.length ? String(open[0].summary || "a change") : "";
    const lines = [];
    if (open.length) lines.push(`🌱 Floyd proposes: ${summary}${open.length > 1 ? ` (+${open.length - 1} more)` : ""} — review in Floyd → Proposals.`);
    if (autoToday.length) lines.push(`🔧 Floyd adjusted: ${autoToday.map((r) => r.summary).filter(Boolean).join("; ")}.`);
    return { line: lines.join("\n"), openTap: open.length, summary };
  } catch {
    return { line: "", openTap: 0, summary: "" };
  }
}

async function reflectProposals(env, input) {
  const prompt =
    `Today is ${input.today} (America/Toronto). You may emit at most ${input.room} proposal(s) tonight — usually emit ZERO.\n\n` +
    `Current SYSTEM_STATE (key→value; an add_card source_key must be a tracked key to auto-apply; retire_flag targets a dead/stale key here):\n${JSON.stringify(input.state)}\n\n` +
    `Open proposals already awaiting action (do NOT duplicate these):\n${JSON.stringify(input.openProposals)}\n\n` +
    `Free-text ideas Floyd jotted from check-ins (promote at most one into a concrete packet if it clearly warrants it):\n${JSON.stringify(input.ideas)}\n\n` +
    (input.health && input.health.length
      ? `VERIFIED health findings from Floyd's self-checks (deterministic facts — weight these over impressions from logs; a retire_flag or set_config that fixes one is a strong candidate):\n${JSON.stringify(input.health)}\n\n`
      : "") +
    `Peter's recent log entries:\n${JSON.stringify(input.logs)}\n\n` +
    `Return ONLY a JSON object (no markdown/prose): {"proposals":[{"summary":"<one human line>","risk":"auto"|"tap","packet":{...whitelisted op...}}]}\n` +
    `Empty list when nothing earns it: {"proposals":[]}.`;

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: env.REFLECT_MODEL || "claude-sonnet-4-6",
      max_tokens: 1200,
      system: REFLECT_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let text = (data.content.find((b) => b.type === "text") || {}).text || "{}";
  const a = text.indexOf("{"), b = text.lastIndexOf("}"); // tolerate stray fences/prose
  if (a >= 0 && b > a) text = text.slice(a, b + 1);
  try { return JSON.parse(text).proposals || []; } catch { return []; }
}

const stateMap = (arr) => { const m = {}; (arr || []).forEach((r) => { if (r && r.key) m[r.key] = r.value; }); return m; };

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
  for (const k of ["current_state", "tasks", "calendar", "partner_state", "partner_presence", "leads", "people", "_meta"]) {
    if (ctx[k]) out[k] = ctx[k];
  }
  // Only unhealthy checks ride along — OK rows are noise the model doesn't need.
  if (Array.isArray(ctx.health)) {
    const bad = ctx.health.filter((h) => h.status === "STALE" || h.status === "FAIL");
    if (bad.length) out.health_issues = bad.map((h) => ({ check: h.check, target: h.target, status: h.status, detail: h.detail }));
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
          " If today_milestones is non-empty, floyd_brief MUST open by warmly acknowledging them (e.g. wishing a happy birthday) before any tasks or health items." +
          " If current_state.power_advisory is present and not 'none', or solar/rain conditions are notable (current_state: solar_today_kwh, solar_forecast_3d, rain_overnight_mm), weave ONE short practical off-grid line into floyd_brief (conserve power / good catchment day / etc.) — only when it actually matters today." +
          " ALWAYS factor partner_presence: if posture is 'solo_focus' (Esther away), this is a deep-work window — make focus_today a solo/project push and lean the intentions toward focused work. If posture is 'protect_together' (Esther home), DO LESS — keep focus_today light and protective of their time together, fewer/gentler intentions. Reflect this in floyd_brief's tone." +
          " If current_state.active_project names a client funnel/business goal, treat revenue work as first-class: weigh context.leads (client pipeline — any lead whose next_date is today/past is overdue and belongs in intentions) and current_state.ntf_traffic_7d (site traffic) when picking focus_today. A booked call always outranks dev work." +
          " If health_issues is present, Floyd's own plumbing is misbehaving — append ONE short matter-of-fact line to floyd_brief naming the most important issue (these are verified facts, not guesses). Never state as current anything a health_issue marks stale.",
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
