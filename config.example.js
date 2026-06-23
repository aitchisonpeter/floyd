/**
 * FLOYD CONFIGURATION — TEMPLATE
 * ─────────────────────────────────────────────────────────────
 * Copy this file to `config.js` and fill in your own values.
 * `config.js` is gitignored so your URL and token stay private;
 * this `.example` template is the committed reference.
 *
 * Steps:
 *  1. Deploy your Google Apps Script as a web app
 *     (Extensions → Apps Script → Deploy → New Deployment) and
 *     copy the /exec URL into `api_url`.
 *  2. Set the same secret as the `API_SECRET` Script Property on
 *     the backend and paste it into `api_secret`.
 *  3. Deploy the Workers (floyd-chat, floyd-checkin) and point
 *     `chat_url` / `checkin_url` at them.
 *  4. Ship config.js alongside index.html / context.html / checkin.html.
 * ─────────────────────────────────────────────────────────────
 */
const FLOYD_CONFIG = {
  // Apps Script web-app /exec URL (or your gateway Worker URL).
  api_url: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
  // Where the PWA is hosted.
  base_url: "https://your-floyd-host.example.com",
  // Shared write token — must match the backend `API_SECRET` Script Property.
  // Sent with every POST. NOTE: visible in client source (raises the bar, not
  // bulletproof); the gateway Worker keeps the real secret server-side.
  api_secret: "YOUR_API_SECRET",
  // Conversational check-in agent (floyd-chat Worker). checkin.html talks to this.
  chat_url: "https://floyd-chat.YOUR_SUBDOMAIN.workers.dev",
  // Action bridge + evolution-loop proposals hub (floyd-checkin Worker).
  checkin_url: "https://floyd-checkin.YOUR_SUBDOMAIN.workers.dev"
};
