# Fix: dashboard won't load (`No route found for GET dashboard`)

## Cause
`index.html` fetches its data with `?type=dashboard`, but the dispatcher has no
route or handler for `dashboard`. The function that builds the dashboard's flat
state — `getSystemData()` — exists but is unreachable. So the call returns
`{"error":"No route found for GET dashboard"}` and the page can't render.

(The `system` route returns the *context-packet* shape — arrays of rows — which
`render()` in `index.html` is not built to consume. So pointing the frontend at
`system` would not fix it; the dashboard needs `getSystemData()`'s flat shape.)

## Fix — add 4 lines to `dispatch()`

In the Apps Script editor, open `dispatch()` and add the `dashboard` short-circuit
right after the auth gate (before the `ROUTE_REGISTRY` lookup):

```javascript
function dispatch(method, key, params, ss, config) {
  // ── AUTH GATE (already present) ─────────────────────────────
  var apiSecret = (config['api_secret'] || '').toString().trim();
  if (apiSecret && method === 'POST') {
    if ((params.token || '').toString() !== apiSecret) {
      return { error: 'Unauthorized' };
    }
  }

  // ── DASHBOARD ROUTE (ADD THIS) ──────────────────────────────
  // index.html's render() expects getSystemData()'s flat shape, which isn't
  // wired into ROUTE_REGISTRY. Serve it directly.
  if (method === 'GET' && key === 'dashboard') {
    return getSystemData(ss, config);
  }

  // ── existing route lookup continues below ───────────────────
  const routes = loadSheet(ss, 'ROUTE_REGISTRY');
  // ...
}
```

## Deploy
Deploy → Manage deployments → (your active deployment) → Edit → Version: **New
version** → Deploy. This keeps the **same** `/exec` URL, so no config change needed.

## Verify
`GET <api_url>?type=dashboard` should return a JSON object with keys like
`system_mode`, `daily_allowance`, `_display_config`, `_actions` — not an `error`.
Then reload the dashboard; the card populates.

## Undo
Remove the 4 added lines and redeploy a new version, or roll back to a prior
deployment version (Apps Script keeps version history).
