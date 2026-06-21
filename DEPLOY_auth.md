# Auth fix — deployment steps

Adds a shared-token gate to every **write** (POST) route. Reads (GET) stay open.

**Backward-compatible:** while the `api_secret` row in CONFIG is blank/absent, the
gate does nothing — so you can deploy the code first with zero risk, then turn on
enforcement only once everything is sending the token.

The token is already wired into the PWA (`config.js` → `api_secret`, sent on every POST).

---

## Rollout order (safe — dashboard never breaks)

1. **Paste the patch** below over the existing `dispatch()` in the Apps Script editor
   (Extensions → Apps Script). Save.
2. **Deploy** → Manage deployments → edit the active deployment → **New version** → Deploy.
   *(At this point `api_secret` is still blank, so nothing is enforced yet — verify the
   dashboard still works.)*
3. **Set the secret** as an Apps Script **Script Property** (Project Settings →
   Script Properties), key `API_SECRET`. (Legacy: it used to live in a
   `CONFIG.api_secret` row; the backend still falls back to that for compat, but
   Script Properties keeps it out of the context packet. Never commit the value.)

   | Location | Key | Value |
   |---|---|---|
   | Script Properties | `API_SECRET` | `<your generated write token>` |

   Enforcement is now live. Writes without the token get `{ error: 'Unauthorized' }`.
4. **Publish the PWA** (`config.js` already holds the matching token). Test a quick log.

To **undo**: clear the `api_secret` row in CONFIG (instant disable), or redeploy the
previous Apps Script version. The local git baseline `04d3332` restores the PWA files.

---

## The patch — replace `dispatch()` with this

```javascript
function dispatch(method, key, params, ss, config) {
  // ── AUTH GATE — require token on all writes when a secret is configured ──
  // Backward-compatible: blank/absent api_secret => no enforcement.
  var apiSecret = (config['api_secret'] || '').toString().trim();
  if (apiSecret && method === 'POST') {
    if ((params.token || '').toString() !== apiSecret) {
      return { error: 'Unauthorized' };
    }
  }

  // Load routes
  const routes = loadSheet(ss, 'ROUTE_REGISTRY');

  // Find matching route (method + key)
  const route = routes.find(r =>
    r.method.toUpperCase() === method.toUpperCase() &&
    r.key === key &&
    (r.status || 'active') === 'active'
  );

  if (!route) {
    // Fallback: bare SYSTEM_STATE write for unknown POST keys
    if (method === 'POST' && key && params.value !== undefined) {
      return handleStateUpdate(key, params, ss, config);
    }
    return { error: 'No route found for ' + method + ' ' + key };
  }

  const routeConfig = safeParseJSON(route.config) || {};

  switch (route.handler_type) {
    case 'import':        return handleImport(params, ss, config, routeConfig);
    case 'sheet_write':   return handleSheetWrite(params, ss, config, routeConfig);
    case 'sheet_read':    return handleSheetRead(params, ss, config, routeConfig);
    case 'context_build': return handleContextBuild(params, ss, config, routeConfig);
    case 'scorer':        return handleScorer(params, ss, config, routeConfig);
    case 'state_update':  return handleStateUpdate(key, params, ss, config);
    default:
      return { error: 'Unknown handler_type: ' + route.handler_type };
  }
}
```

Only the auth-gate block at the top is new — the rest is unchanged.

> **Note on GET reads:** `?type=context` still returns the full life log to anyone
> with the URL. Protecting reads too would break the PWA's simple JSONP loads, so it's
> deliberately left as a later step (token-on-GET, or a server-side proxy).

> **Optional:** update the `dispatch` row in the `CODE` sheet to match, so the
> in-sheet source reference stays accurate.
