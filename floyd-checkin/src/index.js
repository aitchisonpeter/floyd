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
};

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
