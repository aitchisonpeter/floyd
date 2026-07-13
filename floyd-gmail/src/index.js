// Floyd Gmail-ingestion Worker — Phase 2 of the Gmail pipeline. Extends the
// calendar-ingestion pattern (Worker + Claude inline) to email. On a cron it:
//   1. reads recent mail from the Apps Script `peek_gmail` route (curated to the
//      `Floyd` label by default — keeps signal clean, see DEPLOY_gmail.md),
//   2. skips anything already processed (KV dedup, `gmail:<thread_id>`),
//   3. asks Claude to extract ONLY concrete actionable items (task / appointment /
//      bill / travel) — most mail yields nothing,
//   4. POSTs the high-confidence ones through Floyd's universal entries[] door so
//      the existing tag→promote rules file them into TASKS / CALENDAR,
//   5. pushes ONE phone notification summarising what landed.
//
// Mirrors floyd-brief-worker: Worker reads context, calls Claude inline, writes
// back via the token API. Fully server-side — no Mac, no app open.
//
// Secrets (wrangler secret put):  ANTHROPIC_API_KEY, FLOYD_TOKEN
//   FLOYD_TOKEN is the shared api_secret — it's BOTH the POST write token AND the
//   `key` that gates the peek_gmail GET route.
// Vars (wrangler.jsonc): FLOYD_API_URL, GMAIL_MODEL, GMAIL_QUERY, GMAIL_MAX, CHECKIN_URL

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEDUP_TTL_SECONDS = 90 * 24 * 60 * 60; // remember a processed thread for 90 days
const CONFIDENCE_FLOOR = 0.6;                  // below this, don't write — just mark seen

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runGmailIngest(env).catch((e) => console.warn("gmail-ingest:", e.message)));
  },
  // Manual trigger: GET /?key=<FLOYD_TOKEN>
  //   &dry=1        → extract + report, write NOTHING (and don't mark seen)
  //   &q=<query>    → override GMAIL_QUERY for this run (e.g. q=in:inbox to smoke-test)
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("key") !== env.FLOYD_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      return Response.json(await runGmailIngest(env, {
        dry: url.searchParams.get("dry") === "1",
        q: url.searchParams.get("q") || undefined,
      }));
    } catch (e) {
      return new Response("error: " + e.message, { status: 500 });
    }
  },
};

async function runGmailIngest(env, opts = {}) {
  const q = opts.q || env.GMAIL_QUERY || "label:Floyd";
  const max = Math.min(parseInt(env.GMAIL_MAX) || 25, 100);

  const peek = await gmailPeek(env, q, max);
  let threads = peek.threads || [];
  if (!threads.length) return { skipped: "no_mail", query: q };

  // Hard sender denylist (casting/acting solicitations etc.) — dropped before any
  // Claude call. Tune via GMAIL_IGNORE_SENDERS (comma-separated addresses/domains).
  const ignore = String(env.GMAIL_IGNORE_SENDERS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const ignored = [];
  if (ignore.length) {
    threads = threads.filter((t) => {
      const a = String(t.address || t.from || "").toLowerCase();
      const hit = ignore.some((s) => a.includes(s));
      if (hit) ignored.push(t.thread_id);
      return !hit;
    });
  }
  if (!threads.length) return { skipped: "all_ignored", query: q, ignored: ignored.length };

  // Drop anything we've already handled (KV dedup).
  const fresh = [];
  for (const t of threads) {
    const seen = await env.FLOYD_CACHE.get("gmail:" + t.thread_id);
    if (!seen) fresh.push(t);
  }
  if (!fresh.length) return { skipped: "nothing_new", query: q, scanned: threads.length };

  const items = await extractItems(env, fresh);
  // Index extractions by thread for the write + notify steps.
  const byThread = new Map();
  for (const it of items || []) {
    if (it && it.thread_id && it.kind && it.kind !== "none") byThread.set(it.thread_id, it);
  }

  const written = [];
  const entries = [];
  for (const t of fresh) {
    const it = byThread.get(t.thread_id);
    if (it && (it.confidence ?? 1) >= CONFIDENCE_FLOOR) {
      const entry = toEntry(it, t);
      if (entry) { entries.push(entry); written.push({ thread_id: t.thread_id, tag: entry.tag, value: entry.value }); }
    }
  }

  if (opts.dry) {
    return { dry_run: true, query: q, ignored: ignored.length, fresh: fresh.length,
             would_write: written, extracted: items };
  }

  if (entries.length) {
    await floydPost(env, { key: "import_entries", entries });
  }
  // Mark every fresh thread seen — including the ones that yielded nothing — so we
  // never re-spend tokens on the same mail.
  await Promise.all(fresh.map((t) =>
    env.FLOYD_CACHE.put("gmail:" + t.thread_id, "1", { expirationTtl: DEDUP_TTL_SECONDS })));

  if (entries.length) await notify(env, written);

  return { query: q, ignored: ignored.length, fresh: fresh.length, ingested: written.length, written };
}

// ── Claude extraction ────────────────────────────────────────────────────────
const SYSTEM = `You are Floyd — Peter's digital mirror. You triage Peter's incoming email and pull out ONLY concrete, actionable items, so they become entries in his personal log. Voice: terse, factual, no fluff.
Bias HARD to silence. Newsletters, marketing, promos, social notifications, shipping/receipt FYIs with no action, and anything vague earn NOTHING — return them as kind "none". Only emit a real item when there is a clear action Peter must take, a dated appointment, a bill to pay, or a trip/booking.
Peter is NOT involved in acting, casting, or auditions any longer. Treat ALL acting/casting industry mail as noise → kind "none": casting calls, audition notices, casting breakdowns, talent-platform alerts (e.g. Mandy, Casting Workbook), voiceover gigs, and script-reading / film-festival / submission OFFERS (e.g. WILDsound). These are solicitations, never his appointments or tasks.
Never invent details the email doesn't contain. Use the sender + subject + snippet only.`;

async function extractItems(env, threads) {
  const mail = threads.map((t) => ({
    thread_id: t.thread_id, from: t.from, subject: t.subject, date: t.date, snippet: t.snippet,
  }));
  const prompt =
    `Today is ${new Date().toISOString().slice(0, 10)}.\n\n` +
    `Here are ${mail.length} emails. For EACH, decide if it contains a concrete actionable item.\n\n` +
    `${JSON.stringify(mail, null, 0)}\n\n` +
    `Return one result per email (same thread_id). Fields:\n` +
    `- thread_id: echo it back\n` +
    `- kind: "task" | "appointment" | "bill" | "travel" | "none"\n` +
    `- summary: a short imperative line (e.g. "Renew car insurance", "Dentist cleaning"). "" when kind is none.\n` +
    `- date: the relevant date as YYYY-MM-DD if the email implies one (appointment/due/departure), else ""\n` +
    `- detail: one short sentence of supporting context incl. amounts/locations, else ""\n` +
    `- confidence: 0.0–1.0 that this is a real, correctly-classified actionable item\n` +
    `Most should be kind "none". Only go above confidence 0.6 when you're genuinely sure.`;

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: env.GMAIL_MODEL || "claude-sonnet-4-6",
      max_tokens: 1500,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    thread_id: { type: "string" },
                    kind: { type: "string", enum: ["task", "appointment", "bill", "travel", "none"] },
                    summary: { type: "string" },
                    date: { type: "string" },
                    detail: { type: "string" },
                    confidence: { type: "number" },
                  },
                  required: ["thread_id", "kind", "summary", "confidence"],
                  additionalProperties: false,
                },
              },
            },
            required: ["items"],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content.find((b) => b.type === "text") || {}).text || "{}";
  return JSON.parse(text).items || [];
}

// Map an extracted item → a Floyd log entry. The tag drives downstream promotion
// (Floyd's LOG_RULES route #calendar→CALENDAR, #task→TASKS, etc.). For #calendar
// the value must be the date (promoteToCalendar reads value as the date); for the
// rest, value is the human summary.
const KIND_TAG = { task: "#task", appointment: "#calendar", bill: "#bill", travel: "#travel" };

function toEntry(it, thread) {
  const tag = KIND_TAG[it.kind];
  if (!tag) return null;
  const fromName = (String(thread.from || "").match(/^"?([^"<]+?)"?\s*</) || [, thread.address || thread.from])[1];
  const ctx = [it.detail, it.date ? `(${it.date})` : "", `— via email from ${String(fromName || "").trim()}`]
    .filter(Boolean).join(" ");
  if (it.kind === "appointment") {
    return { tag, value: it.date || "", notes: `${it.summary}. ${ctx}`.trim(), source: "gmail", ai: "claude_gmail" };
  }
  return { tag, value: it.summary, notes: ctx, source: "gmail", ai: "claude_gmail" };
}

// ── Phone notification (one line, via floyd-checkin) ─────────────────────────
async function notify(env, written) {
  if (!env.CHECKIN_URL || !written.length) return;
  const head = written.slice(0, 3).map((w) => w.value || w.tag).join(" · ");
  const more = written.length > 3 ? ` (+${written.length - 3})` : "";
  const q = new URLSearchParams({
    key: env.FLOYD_TOKEN, type: "notify",
    title: `Floyd filed ${written.length} from email 📥`,
    text: head + more,
  });
  await fetch(`${env.CHECKIN_URL}/?${q}`).catch(() => {});
}

// ── Floyd API ────────────────────────────────────────────────────────────────
async function gmailPeek(env, q, max) {
  const u = new URL(env.FLOYD_API_URL);
  u.searchParams.set("type", "peek_gmail");
  u.searchParams.set("key", env.FLOYD_TOKEN); // gmail routes are token-gated on `key`
  u.searchParams.set("q", q);
  u.searchParams.set("max", String(max));
  u.searchParams.set("t", Date.now().toString());
  const res = await fetch(u, { redirect: "follow" });
  if (!res.ok) throw new Error(`peek_gmail HTTP ${res.status}`);
  const json = await res.json();
  if (json && json.error) throw new Error(`peek_gmail: ${json.error}`);
  return json;
}

async function floydPost(env, body) {
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
