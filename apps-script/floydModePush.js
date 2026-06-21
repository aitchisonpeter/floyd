/**
 * Floyd → Pi presence push.  Keeps the Pi's floyd_mode.json cache fresh so the
 * Roomba scheduler defers to Floyd while Peter is home and falls back to the
 * offline failsafe (dusk + 1am) when Floyd goes quiet.
 *
 * The Pi treats mode === 'tuliptown' as "home, defer to Floyd"; anything else
 * (van / anywhere / stale / missing) → run. We push `currentContext`
 * (resolveTaskContext output): 'tuliptown' at home, 'van'/'anywhere' away.
 *
 * The endpoint URL defaults to the constant below (not a secret). The SECRET is
 * read only from CONFIG (floyd_api_secret) — never baked into source. Until that
 * CONFIG row exists, pushFloydMode safely no-ops.
 */

var FLOYD_API_URL_FALLBACK = 'https://floyd-api.tuliptown.ca';

/**
 * POST the current presence mode to floyd-api. Fire-and-forget: a Pi/network
 * outage must never break Floyd (the Pi's own failsafe covers staleness).
 *
 * @param {Object} config           loadConfig(ss) result
 * @param {string} mode             presence/context to push (e.g. 'tuliptown')
 * @param {number} [minIntervalSec] skip a redundant push of the SAME mode within
 *                                  this window (still pushes on a mode change)
 */
function pushFloydMode(config, mode, minIntervalSec) {
  try {
    config = config || {};
    var url    = config['floyd_api_url'] || FLOYD_API_URL_FALLBACK;
    var secret = config['floyd_api_secret'];           // CONFIG-only; no source secret
    if (!url || !secret || !mode) return;
    mode = String(mode);

    if (minIntervalSec) {
      var cache = CacheService.getScriptCache();
      if (cache.get('floyd_mode_last') === mode) return;   // unchanged & recent
      cache.put('floyd_mode_last', mode, minIntervalSec);
    }

    UrlFetchApp.fetch(url.replace(/\/+$/, '') + '/mode', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Floyd-Secret': secret },
      payload: JSON.stringify({ mode: mode }),
      muteHttpExceptions: true,
    });
  } catch (err) {
    console.warn('pushFloydMode failed: ' + err);
  }
}

/** Time-driven heartbeat: recompute presence and push it, unconditionally. */
function floydModeHeartbeat() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var config = loadConfig(ss);
  var stateSheet = ss.getSheetByName('SYSTEM_STATE');
  var state = {};
  stateSheet.getDataRange().getValues().slice(1).forEach(function (r) {
    if (r[0]) state[r[0]] = r[1];
  });
  var locInfo = determineMode(state['current_location'] || '', config);
  var context = resolveTaskContext(locInfo.mode, config);
  pushFloydMode(config, context);   // no throttle — heartbeat always refreshes
}

/** Seed the floyd_api_url row (non-secret) into CONFIG if missing, for visibility. */
function seedFloydConfig(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('CONFIG');
  if (!sheet) return;
  var have = {};
  sheet.getDataRange().getValues().forEach(function (r) { if (r[0]) have[r[0]] = true; });
  if (!have['floyd_api_url']) sheet.appendRow(['floyd_api_url', FLOYD_API_URL_FALLBACK]);
  // NOTE: floyd_api_secret is intentionally NOT seeded — add it by hand in CONFIG.
}

/** Run once: seed the URL row + (re)install the 6-hourly heartbeat trigger. */
function installFloydModeTrigger() {
  seedFloydConfig();
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'floydModeHeartbeat'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('floydModeHeartbeat').timeBased().everyHours(6).create();
  console.log('URL seeded + floydModeHeartbeat trigger installed (every 6h)');
}
