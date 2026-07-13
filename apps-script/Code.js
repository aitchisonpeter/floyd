/**
 * FLOYD APPS SCRIPT — code.gs
 * v3.4 — Validation-as-growth, meta rescue, double-promotion guard, feedback loop
 *
 * Core principle: Every operation Floyd can perform is a row in a sheet.
 * Code only reads rows and executes them. Nothing is hardcoded except
 * the six handler types below.
 *
 * HANDLER TYPES (the only enum in code):
 *   import        — write entries to PERSONAL_LOG
 *   sheet_write   — read/write any sheet directly
 *   sheet_read    — query any sheet and return data
 *   context_build — assemble a context packet
 *   scorer        — score text against a keyword sheet
 *   state_update  — write a key/value to SYSTEM_STATE
 *
 * v3.4 CHANGES:
 *   1. Meta runs even when tag validation fails. Invalid-tag entries
 *      with valid meta ops still execute the side effect. The log row
 *      is not appended, but the intent is preserved.
 *   2. Meta handlers mark the source log entry as 'promoted' after
 *      successful target write, preventing PROMOTION_RULES from
 *      double-firing on the same entry.
 *   3. VALIDATION_LOG feeds back into checkin: unresolved count surfaces
 *      in lean prep, detail endpoint returns grouped errors for AI
 *      to propose growth (new tags → LOG_RULES additions).
 *   4. When sheet_write adds rows to LOG_RULES, matching VALIDATION_LOG
 *      entries auto-resolve.
 *
 * GROWTH PATTERN:
 *   New endpoint       → new row in ROUTE_REGISTRY
 *   New transform      → new row in TRANSFORM_REGISTRY
 *   New meta op        → new row in META_HANDLERS
 *   New sheet          → sheet_write with headers param
 *   New context        → new row in CONTEXT_SCHEMA
 *   New promotion      → new row in PROMOTION_RULES
 *   New auto-qual      → set auto_qualify=true in LOG_RULES
 *   New task context   → add context value to TASKS col 5
 *   New tag            → add to LOG_RULES (often via validation growth loop)
 *   Everything else    → JSON packet → import
 *
 * ENTRY LIFECYCLE:
 *   INTAKE → QUALIFY → PROMOTE → SURFACE → COMPLETE
 *   Unqualified entries surface in checkin as a count.
 *   AI requests detail on demand via context request.
 *   AI clarifies type + context, generates promotion packet.
 *   Dashboard surfaces only tasks matching current location context.
 *
 * STANDARD SHEET TEMPLATE (all non-infrastructure sheets):
 *   id | key | value | status | context | notes | meta | updated
 *   EXCEPTION: SYSTEM_STATE uses key | value | status | context | notes | meta | updated
 *   (no id — keys are unique identifiers, writeStateKey matches on col 1)
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const PROTECTED_SHEETS = ['VALIDATION_LOG'];
const HANDLER_TYPES    = ['import', 'sheet_write', 'sheet_read', 'context_build', 'scorer', 'state_update'];
const TASK_CONTEXTS    = ['van', 'tuliptown', 'anywhere'];

// VALIDATION_LOG column positions (1-indexed as used in sheet API)
const VL_COL_TIMESTAMP = 1;
const VL_COL_AI        = 2;
const VL_COL_TYPE      = 3;
const VL_COL_ENTRY     = 4;
const VL_COL_MESSAGE   = 5;
const VL_COL_RESOLVED  = 6;

// ============================================================================
// ENTRY POINTS
// ============================================================================

function doGet(e) {
  try {
    const type     = (e.parameter.type || '').toString().trim();
    const callback = e.parameter.callback;
    const ss       = SpreadsheetApp.getActiveSpreadsheet();
    const config   = loadConfig(ss);

    const result = dispatch('GET', type, e.parameter, ss, config);

    // CSV lens output — a lens with format=csv returns { _csv }; emit it raw.
    if (result && result._csv !== undefined) {
      return ContentService
        .createTextOutput(result._csv)
        .setMimeType(ContentService.MimeType.CSV);
    }

    const json   = JSON.stringify(result);

    if (callback) {
      return ContentService
        .createTextOutput(callback + '(' + json + ')')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService
      .createTextOutput(json)
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.message, stack: err.stack }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  try {
    const params = JSON.parse(e.postData.contents);
    const key    = (params.key || params.path || '').toString().trim();
    const ss     = SpreadsheetApp.getActiveSpreadsheet();
    const config = loadConfig(ss);

    const result = dispatch('POST', key, params, ss, config);
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.message, stack: err.stack }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================================
// DISPATCHER
// ============================================================================

function dispatch(method, key, params, ss, config) {
  // ── AUTH GATE — require token on all writes when a secret is configured ──
  // Secret comes from Script Properties first (never serialized into a context
  // packet), falling back to CONFIG for backward-compat during migration.
  // Blank/absent => no enforcement (backward-compatible).
  var apiSecret = getApiSecret(config);
  if (apiSecret && method === 'POST') {
    if ((params.token || '').toString() !== apiSecret) {
      return { error: 'Unauthorized' };
    }
  }

  // ── DASHBOARD ROUTE → flat state shape that index.html expects ──
  if (method === 'GET' && key === 'dashboard') {
    return getSystemData(ss, config);
  }

  // ── CALENDAR SYNC (token-gated GET; side-effecting) ──
  if (method === 'GET' && (key === 'sync_calendar' || key === 'install_calendar_trigger')) {
    var sec = getApiSecret(config);
    if (sec && (params.key || '').toString() !== sec) return { error: 'Unauthorized' };
    return key === 'sync_calendar' ? syncGoogleCalendar(ss, config, params) : installCalendarTrigger();
  }

  // ── ALARM PARSE TEST (no-send; verifies notes-to-alarms parsing) ──
  if (method === 'GET' && key === 'alarm_parse') {
    return { text: params.text || '', parsed: parseAlarmIntent(params.text || '', config) };
  }

  // ── LIST CALENDARS (token-gated; to discover a shared calendar's exact name) ──
  if (method === 'GET' && key === 'list_calendars') {
    var sec2 = getApiSecret(config);
    if (sec2 && (params.key || '').toString() !== sec2) return { error: 'Unauthorized' };
    return { calendars: CalendarApp.getAllCalendars().map(function (c) {
      return { name: c.getName(), id: c.getId(), mine: c.isOwnedByMe() };
    }) };
  }

  // ── PEEK CALENDAR (token-gated; inspect how events are logged) ──
  if (method === 'GET' && key === 'peek_calendar') {
    var sec3 = getApiSecret(config);
    if (sec3 && (params.key || '').toString() !== sec3) return { error: 'Unauthorized' };
    var cals3 = resolveCalendars(params.name || params.id || '');
    if (!cals3 || !cals3.length) return { error: 'no calendar for ' + (params.name || params.id || '') };
    var nowP = new Date(), endP = new Date(nowP.getTime() + (parseInt(params.days) || 45) * 86400000);
    return { calendar: params.name, events: cals3[0].getEvents(nowP, endP).map(function (ev) {
      var allDay = ev.isAllDayEvent();
      var sp = allDay ? Math.round((ev.getAllDayEndDate() - ev.getAllDayStartDate()) / 86400000) : null;
      return { title: ev.getTitle(), all_day: allDay, span_days: sp,
               start: (allDay ? ev.getAllDayStartDate() : ev.getStartTime()).toISOString(),
               end: (allDay ? ev.getAllDayEndDate() : ev.getEndTime()).toISOString() };
    }) };
  }

  // ── GMAIL HYGIENE (token-gated; same no-OAuth-client trick as CalendarApp) ──
  // The web app runs as USER_DEPLOYING, so GmailApp reads/trashes that account's
  // mail with no OAuth client. All gmail routes are token-gated (mail is sensitive
  // and the read routes are otherwise open). cleanup_gmail is DRY-RUN unless
  // confirm=1; make_gmail_filter stops future noise at the door.
  if (method === 'GET' && (key === 'peek_gmail' || key === 'gmail_senders' ||
                           key === 'cleanup_gmail' || key === 'make_gmail_filter')) {
    var gsec = getApiSecret(config);
    if (gsec && (params.key || '').toString() !== gsec) return { error: 'Unauthorized' };
    if (key === 'peek_gmail')        return peekGmail(params);
    if (key === 'gmail_senders')     return gmailSenderStats(params);
    if (key === 'cleanup_gmail')     return cleanupGmail(ss, config, params);
    if (key === 'make_gmail_filter') return makeGmailFilter(params);
  }

  // ── ARCHIVE TAIL (T037) — token-gated reader for PERSONAL_LOG_ARCHIVE ─────
  // The archive holds raw expired rows (notification previews etc.); it must
  // never sit on an OPEN read surface. This is its only reader — token in the
  // ?key= param, same gate as gmail_senders. params: n (rows back, default 20).
  if (method === 'GET' && key === 'archive_tail') {
    var asec = getApiSecret(config);
    if (asec && (params.key || '').toString() !== asec) return { error: 'Unauthorized' };
    var arch = ss.getSheetByName('PERSONAL_LOG_ARCHIVE');
    if (!arch) return { status: 'success', exists: false, rows: [] };
    var last = arch.getLastRow();
    if (last < 2) return { status: 'success', exists: true, count: 0, rows: [] };
    var n      = Math.min(parseInt(params.n) || 20, 200);
    var header = arch.getRange(1, 1, 1, arch.getLastColumn()).getValues()[0];
    var start  = Math.max(2, last - n + 1);
    var vals   = arch.getRange(start, 1, last - start + 1, arch.getLastColumn()).getValues();
    return { status: 'success', exists: true, count: last - 1,
             rows: vals.map(function (r) { var o = {}; header.forEach(function (h, i) { o[h || ('col' + (i + 1))] = r[i]; }); return o; }) };
  }

  // ── CORRESPONDENCE (T040) — token-gated capture + reader ─────────────────
  // Both hold/emit per-person email content, so BOTH require the token (same
  // gate as gmail_senders) — CORRESPONDENCE never sits on an open surface.
  // capture: side-effecting Gmail pull (nightly via floyd-brief, or manual).
  //   ?type=capture_correspondence&key=<token>[&days=&per_person=&dry=1]
  // read:   ?type=correspondence&key=<token>[&person=P_xxx&n=50]
  if (method === 'GET' && (key === 'capture_correspondence' || key === 'correspondence')) {
    var csec = getApiSecret(config);
    if (csec && (params.key || '').toString() !== csec) return { error: 'Unauthorized' };
    if (key === 'capture_correspondence') return captureCorrespondence(ss, config, params);
    // reader
    var cs = ss.getSheetByName('CORRESPONDENCE');
    if (!cs) return { status: 'success', exists: false, rows: [] };
    var clast = cs.getLastRow();
    if (clast < 2) return { status: 'success', exists: true, count: 0, rows: [] };
    var chead = cs.getRange(1, 1, 1, cs.getLastColumn()).getValues()[0];
    var cvals = cs.getRange(2, 1, clast - 1, cs.getLastColumn()).getValues();
    var person = (params.person || '').toString().trim();
    var mapped = cvals.map(function (r) { var o = {}; chead.forEach(function (h, i) { o[h || ('col' + (i + 1))] = r[i]; }); return o; });
    if (person) mapped = mapped.filter(function (o) { return o.person_id === person; });
    var cn = Math.min(parseInt(params.n) || 50, 500);
    return { status: 'success', exists: true, count: mapped.length, rows: mapped.slice(-cn) };
  }

  // ── GMAIL DRAFT (funnel outreach; gated by the POST auth above) ──
  // POST { key:'make_gmail_draft', to, subject, body } → creates a draft in
  // Peter's Gmail. Floyd NEVER sends — Peter reviews and hits Send himself.
  if (method === 'POST' && key === 'make_gmail_draft') {
    if (!params.to || !params.subject || !params.body) {
      return { error: 'make_gmail_draft needs to, subject, body' };
    }
    // to:'self' → draft addressed to the owner (LinkedIn paste-drafts: the body
    // is a DM Peter copies out; the draft is just the review surface). Read from
    // CONFIG.owner_email — Session.getEffectiveUser needs a scope we don't carry.
    var draftTo = params.to.toString() === 'self'
      ? (config['owner_email'] || '').toString()
      : params.to.toString();
    if (!draftTo) return { error: 'make_gmail_draft: CONFIG.owner_email not set' };
    var draft = GmailApp.createDraft(draftTo, params.subject.toString(), params.body.toString());
    return { status: 'success', draft_id: draft.getId(), to: draftTo };
  }

  // ── EVOLUTION LOOP — apply a proposed mutation (gated by the POST auth above) ──
  // Special dispatch branch (not a ROUTE_REGISTRY handler_type): the executor is a
  // whitelist, so it must stay in code. POST { key:'apply_proposal', id, auto? }.
  if (method === 'POST' && key === 'apply_proposal') {
    return applyProposal(params, ss, config);
  }

  // ── SELF-VERIFICATION SETUP (v3.6) — idempotent, gated by POST auth ──────
  // Provisions the HEALTH registry + route + context row, closes the #task
  // promotion loop, sweeps replayed rows, and runs the health checks once.
  if (method === 'POST' && key === 'run_setup') {
    ensureProposalsSheet();
    const lensSetup   = ensureLensesSheet(ss);
    const healthSetup = ensureHealthSheet();
    const loopRows    = setupLoopClosureRows(ss);
    const purged      = purgeDuplicateEntries(ss);
    const health      = refreshHealth(ss, config);
    return { status: 'success', lenses_sheet: lensSetup, health_sheet: healthSetup, loop_closure: loopRows, duplicates_purged: purged, health_results: health };
  }


  // ── existing route lookup continues below (leave as-is) ──
  const routes = loadSheet(ss, 'ROUTE_REGISTRY');

  // Find matching route (method + key)
  const route = routes.find(r =>
    r.method.toUpperCase() === method.toUpperCase() &&
    r.key === key &&
    (r.status || 'active') === 'active'
  );

  if (!route) {
    // UNIVERSAL INGESTION — one door in. Any POST carrying an entries[] array is
    // a log append, regardless of key. Lets every source (Tasker, websites, MCP,
    // n8n) POST to a single /log endpoint with { token, entries:[...] } and have
    // the tag drive everything downstream. No ROUTE_REGISTRY row required.
    if (method === 'POST' && Array.isArray(params.entries) && params.entries.length) {
      return handleImport(params, ss, config, {});
    }
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

// ============================================================================
// HANDLER: IMPORT
//
// v3.4 behavior: when an entry fails tag validation, check if it has a
// usable meta op. If yes, execute the meta (preserves intent) and log
// the validation issue as a tag-growth signal. The entry itself does
// not land in PERSONAL_LOG.
// ============================================================================

function handleImport(params, ss, config, routeConfig) {
  const entries      = params.entries || [];
  const ownerId      = config['owner_id']       || 'owner';
  const ownerBirthday= config['owner_birthday'] || '1981-01-01';
  const now          = new Date();
  const personalLog  = ss.getSheetByName('PERSONAL_LOG');
  const autoQualTags = loadAutoQualifyTags(ss);
  const validTags    = loadValidTags(ss);

  const results = { imported: 0, invalid: [], warnings: [], rescued_via_meta: 0 };

  // ── DEDUPE AT THE STORE BOUNDARY (v3.6) ─────────────────────────────────
  // An entry identical to a recent row (tag+person+value+notes) is a replay:
  // notification double-fires, agent re-logs across turns, client retries.
  // Enforced here — not per client — so every writer, present and future,
  // inherits it. Window is per-tag via LOG_RULES.dedupe_min, else
  // CONFIG.dedupe_window_min (default 240). 0 disables for that tag.
  const dedupeWindows = loadDedupeWindows(ss, config);
  const recentSigs    = buildRecentSignatures(personalLog, now);

  entries.forEach((entry, i) => {
    const sig       = entrySignature(entry, config['owner_id'] || 'owner');
    const windowMin = dedupeWindowFor(entry.tag, dedupeWindows);
    if (windowMin > 0 && recentSigs[sig] !== undefined && (now.getTime() - recentSigs[sig]) < windowMin * 60000) {
      results.deduped = (results.deduped || 0) + 1;
      return;
    }
    recentSigs[sig] = now.getTime(); // catches duplicates within this same batch
    // Drop unresolved-placeholder notifications (broken phone-side template,
    // e.g. value "<notification title>" / "%antitle") before they pollute the
    // log. These arrive via import_entries with tag #notification.
    if ((entry.tag || '') === '#notification') {
      const metaObj0 = typeof entry.meta === 'string' ? safeParseJSON(entry.meta) : (entry.meta || {});
      const pkg0     = (metaObj0 && metaObj0.package) || '';
      if (isUnresolvedNotification(entry.value, entry.notes, pkg0)) {
        results.skipped = (results.skipped || 0) + 1;
        return;
      }
    }

    let tagValid = true;
    let validationError = null;

    try {
      validateEntry(entry, validTags);
    } catch (err) {
      tagValid = false;
      validationError = err.message;
    }

    // v3.4 RESCUE PATH: entry failed validation, but if it has valid meta,
    // still execute the meta so the intent isn't lost. Log the validation
    // issue for the growth feedback loop.
    if (!tagValid) {
      const hasRescuableMeta = entry.meta && hasValidMetaType(entry.meta);
      if (hasRescuableMeta) {
        try {
          processMeta(entry, ss, config, now, null); // null = no source log row
          results.rescued_via_meta++;
        } catch (metaErr) {
          // Meta itself failed — fall through to invalid-record path
          results.invalid.push({ index: i, error: validationError + ' (meta rescue failed: ' + metaErr.message + ')' });
          logValidationIssue({ ai: params.ai, type: 'invalid', entry, message: validationError }, ss);
          return;
        }
      }

      // Always log the validation issue — even rescued ones, so the growth
      // loop can surface "this tag keeps getting used, register it?"
      logValidationIssue({ ai: params.ai, type: 'invalid', entry, message: validationError }, ss);
      results.invalid.push({ index: i, error: validationError, rescued: hasRescuableMeta });
      return;
    }

    if (entry.confidence && entry.confidence < 0.5) {
      results.warnings.push({ index: i, warning: 'Low confidence' });
    }

    const id         = 'I' + now.getTime() + '_' + i;
    const daysAlive  = entry.days_alive || Math.floor((now - new Date(ownerBirthday)) / 86400000);
    const isQualified = entry.qualified === true || entry.qualified === 'true' || autoQualTags.includes(entry.tag);

    personalLog.appendRow([
      daysAlive,
      now.toISOString(),
      id,
      entry.person || ownerId,
      entry.tag    || '#note',
      entry.value  || '',
      entry.notes  || '',
      typeof entry.meta === 'object' ? JSON.stringify(entry.meta) : (entry.meta || ''),
      entry.ai ? 'ai_' + entry.ai : 'ai_import',
      'active',
      entry.confidence || 1,
      isQualified ? 'true' : 'false'
    ]);

    // Force the Value cell to plain text so ratings like "7/10" or "7hrs"
    // aren't auto-coerced into dates by Sheets.
    personalLog.getRange(personalLog.getLastRow(), 6).setNumberFormat('@').setValue(entry.value || '');

    // Capture the row index we just appended (last row of sheet)
    const sourceRowIndex = personalLog.getLastRow();

    if (entry.meta) {
      // v3.4: pass sourceRowIndex so meta can mark the row 'promoted' and
      // prevent runPromotionRules from double-firing on the same entry.
      processMeta(entry, ss, config, now, sourceRowIndex);
    }

    // T021: notes-to-alarms — an explicit reminder/alarm intent in a note fires a
    // phone alarm via the floyd-checkin Join bridge. Gated by CONFIG.alarms_from_notes
    // ('on' to arm); deterministic + explicit-intent only, so casual time mentions
    // never create phantom alarms. Best-effort: never breaks the import.
    if (config['alarms_from_notes'] === 'on' && (entry.tag || '') !== '#notification' && entry.value) {
      try { maybeCreateAlarmFromNote(entry.value.toString(), ss, config); } catch (e) {}
    }

    // v3.5: run notification parser for #notification entries via import_entries
    if ((entry.tag || '') === '#notification') {
      const metaObj = typeof entry.meta === 'string' ? safeParseJSON(entry.meta) : (entry.meta || {});
      const pkg = (metaObj && metaObj.package) || '';
      const notification = {
        title: entry.value || '',
        text:  entry.notes || ''
      };
      // Side-effect processing is decoupled from the write: the row is already
      // in PERSONAL_LOG, so a parser bug can never fail the import. The raw event
      // survives; only the derived spend/stats are skipped on error.
      try {
        parseNotificationWithRules(ss, pkg, notification, now, config);
        updateNotificationStats(ss, pkg, notification);
      } catch (npErr) {
        logValidationIssue({ ai: params.ai, type: 'notification_parse', entry, message: npErr.message }, ss);
      }
    }

    applyLogRules(ss, entry.tag || '#note');
    promoteEntryToState(ss, entry, config, now);
    results.imported++;
  });

  logSession(ss, params, results.imported, ownerBirthday, now);

  // Post-import pipeline — qualify auto tags then run promotions
  qualifyAutoEntries(ss, now, ownerBirthday);
  runPromotionRules(ss, config, now);

  return { status: 'success', ...results };
}

// Returns true if meta object has a type that has an active handler
// (either in META_HANDLERS or in processMetaFallback).
function hasValidMetaType(meta) {
  const metaObj = typeof meta === 'string' ? safeParseJSON(meta) : meta;
  if (!metaObj || !metaObj.type) return false;
  const fallbackTypes = ['promotion', 'schema_update', 'qualify', 'state_update'];
  return fallbackTypes.includes(metaObj.type);
}

// ============================================================================
// QUALIFICATION — auto-qualifies entries whose tag has auto_qualify=true
// ============================================================================

function qualifyAutoEntries(ss, now, ownerBirthday) {
  const logSheet = ss.getSheetByName('PERSONAL_LOG');
  if (!logSheet) return;

  const todayDa  = Math.floor((now - new Date(ownerBirthday)) / 86400000);
  const cutoffDa = todayDa - 30;
  const autoQual = loadAutoQualifyTags(ss);

  if (autoQual.length === 0) return;

  const data      = logSheet.getDataRange().getValues();
  const toQualify = [];

  for (let i = 1; i < data.length; i++) {
    const row       = data[i];
    const da        = parseInt(row[0]);
    const tag       = (row[4]  || '').toString().trim();
    const qualified = (row[11] || '').toString().toLowerCase();
    const status    = (row[9]  || '').toString().toLowerCase();

    if (qualified === 'true')         continue;
    if (status === 'promoted')        continue;
    if (status === 'dormant')         continue;
    if (tag === '#unresolved')        continue;
    if (isNaN(da) || da < cutoffDa)  continue;
    if (autoQual.includes(tag))       toQualify.push(i + 1);
  }

  toQualify.forEach(sheetRow => {
    logSheet.getRange(sheetRow, 12).setValue('true');
  });
}

// ============================================================================
// PROMOTION — reads PROMOTION_RULES, pushes qualified entries to destinations
// ============================================================================

// Scheduled entry point for the daily time-based trigger.
// Promotion normally runs inline during handleImport(); this nightly sweep is
// the safety net that catches entries qualified after their import (e.g. by the
// overnight qualifier) and pushes them to their destinations. Zero-arg so it can
// be invoked directly by the ScriptApp time trigger.
function promoteToPersonalLog() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const config = loadConfig(ss);
  runPromotionRules(ss, config, new Date());
  purgeUnresolvedNotifications(ss); // self-heal: sweep out any placeholder noise
  purgeDuplicateEntries(ss);        // self-heal: collapse replayed rows
  refreshHealth(ss, config);        // nightly loop-closure + staleness checks
}

// Deletes #notification rows whose title/text/package are unresolved sender
// placeholders ("<notification title>", "%antitle", ...). These carry zero real
// information — janitorial cleanup, not overwriting the mirror. Safe to re-run:
// the strict isUnresolvedNotification() match can only hit pure-placeholder rows.
// Returns the number of rows removed. Runnable standalone from the editor too.
function purgeUnresolvedNotifications(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName('PERSONAL_LOG');
  if (!logSheet) return 0;

  const data = logSheet.getDataRange().getValues();
  let removed = 0;

  // Bottom-up so row deletions don't shift the indexes still to be checked.
  for (let i = data.length - 1; i >= 1; i--) {
    const row = data[i];
    if ((row[4] || '').toString().trim() !== '#notification') continue;
    const meta = safeParseJSON(row[7]) || {};
    const pkg  = (meta && meta.package) || '';
    if (isUnresolvedNotification(row[5], row[6], pkg)) {
      logSheet.deleteRow(i + 1);
      removed++;
    }
  }
  return removed;
}

// ── Boundary-dedupe helpers (v3.6) ──────────────────────────────────────────
// Signature = tag|person|value|notes (trimmed). Identical text within the
// window is a replay, not a new fact. Notes are included so a legitimate
// re-log with different context (e.g. same #energy value, new note) survives.
function entrySignature(entry, ownerId) {
  const t = (v) => (v === undefined || v === null) ? '' : v.toString().trim();
  return [t(entry.tag), t(entry.person) || ownerId, t(entry.value), t(entry.notes)].join('|');
}

// Per-tag window from LOG_RULES.dedupe_min (optional column), falling back to
// CONFIG.dedupe_window_min, falling back to 240. #notification defaults to 10
// (double-fire guard) unless LOG_RULES overrides — identical texts re-sent an
// hour apart are real messages, not replays.
function loadDedupeWindows(ss, config) {
  const out = { byTag: {}, defaultMin: parseInt(config['dedupe_window_min']) || 240 };
  const sheet = ss.getSheetByName('LOG_RULES');
  if (!sheet) return out;
  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().toLowerCase().trim());
  const tagCol  = headers.indexOf('tag');
  const ddCol   = headers.indexOf('dedupe_min');
  if (tagCol === -1 || ddCol === -1) return out;
  data.slice(1).forEach(r => {
    if (r[tagCol] && r[ddCol] !== '' && r[ddCol] !== null && !isNaN(parseInt(r[ddCol]))) {
      out.byTag[r[tagCol]] = parseInt(r[ddCol]);
    }
  });
  return out;
}

function dedupeWindowFor(tag, windows) {
  if (windows.byTag[tag] !== undefined) return windows.byTag[tag];
  if (tag === '#notification') return 10;
  return windows.defaultMin;
}

// Map signature → newest timestamp(ms) over the recent tail of PERSONAL_LOG.
// 400 rows comfortably covers the largest realistic dedupe window.
function buildRecentSignatures(logSheet, now) {
  const sigs = {};
  if (!logSheet) return sigs;
  const lastRow = logSheet.getLastRow();
  if (lastRow < 2) return sigs;
  const n     = Math.min(400, lastRow - 1);
  const data  = logSheet.getRange(lastRow - n + 1, 1, n, 7).getValues();
  data.forEach(r => {
    const ts = new Date(r[1]).getTime();
    if (isNaN(ts)) return;
    const t = (v) => (v === undefined || v === null) ? '' : v.toString().trim();
    const sig = [t(r[4]), t(r[3]), t(r[5]), t(r[6])].join('|');
    if (sigs[sig] === undefined || ts > sigs[sig]) sigs[sig] = ts;
  });
  return sigs;
}

// Janitorial sweep for duplicates that predate the boundary dedupe (or slipped
// through a bug): within the last `lookback` rows, rows identical by signature
// to an EARLIER row within `windowMin` are deleted, keeping the first. Same
// self-heal class as purgeUnresolvedNotifications — replays carry zero real
// information. Safe to re-run.
function purgeDuplicateEntries(ss, windowMin, lookback) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  windowMin = windowMin || 360;
  lookback  = lookback  || 1500;
  const logSheet = ss.getSheetByName('PERSONAL_LOG');
  if (!logSheet) return 0;

  const lastRow  = logSheet.getLastRow();
  if (lastRow < 3) return 0;
  const n        = Math.min(lookback, lastRow - 1);
  const startRow = lastRow - n + 1;
  const data     = logSheet.getRange(startRow, 1, n, 7).getValues();

  const t = (v) => (v === undefined || v === null) ? '' : v.toString().trim();
  const firstSeen = {}; // sig → first timestamp(ms)
  const toDelete  = [];

  data.forEach((r, i) => {
    const ts = new Date(r[1]).getTime();
    if (isNaN(ts)) return;
    const sig = [t(r[4]), t(r[3]), t(r[5]), t(r[6])].join('|');
    if (firstSeen[sig] !== undefined && (ts - firstSeen[sig]) < windowMin * 60000) {
      toDelete.push(startRow + i);
    } else if (firstSeen[sig] === undefined) {
      firstSeen[sig] = ts;
    }
  });

  // Bottom-up so deletions don't shift pending indexes.
  toDelete.reverse().forEach(row => logSheet.deleteRow(row));
  return toDelete.length;
}

function runPromotionRules(ss, config, now) {
  const rulesSheet = ss.getSheetByName('PROMOTION_RULES');
  if (!rulesSheet) return;

  const stateSheet = ss.getSheetByName('SYSTEM_STATE');
  const logSheet   = ss.getSheetByName('PERSONAL_LOG');
  if (!stateSheet || !logSheet) return;

  const rulesData    = rulesSheet.getDataRange().getValues();
  const rulesHeaders = rulesData[0].map(h => h.toString().toLowerCase().trim());

  const idCol         = rulesHeaders.indexOf('id');
  const keyCol        = rulesHeaders.indexOf('key');
  const tagCol        = rulesHeaders.indexOf('value');
  const activeCol     = rulesHeaders.indexOf('status');
  const contextCol    = rulesHeaders.indexOf('context');
  const promoteToCol  = rulesHeaders.indexOf('meta');

  const getLogKey    = (r) => keyCol >= 0    ? r[keyCol]    : r[0];
  const getTriggerTag= (r) => tagCol >= 0    ? r[tagCol]    : r[1];
  const getActive    = (r) => activeCol >= 0 ? r[activeCol] : r[3];
  const getContext   = (r) => contextCol >= 0? r[contextCol]: r[5] || 'anywhere';
  const getPromoteTo = (r) => {
    if (promoteToCol >= 0) {
      const meta = safeParseJSON(r[promoteToCol]);
      if (meta && meta.promote_to) return meta.promote_to;
      return (r[promoteToCol] || 'system_state').toString().toLowerCase();
    }
    return r[4] ? r[4].toString().toLowerCase() : 'system_state';
  };

  const logData = logSheet.getDataRange().getValues();

  rulesData.slice(1).forEach(rule => {
    const logKey     = (getLogKey(rule)     || '').toString().trim();
    const triggerTag = (getTriggerTag(rule) || '').toString().trim();
    const activeVal  = getActive(rule);
    const active     = activeVal === true || activeVal === 'TRUE' || activeVal === 'true' || activeVal === 'active';
    const promoteTo  = getPromoteTo(rule);
    const context    = (getContext(rule) || 'anywhere').toString().trim().toLowerCase();

    if (!logKey || !triggerTag || !active) return;

    for (let i = logData.length - 1; i >= 1; i--) {
      const row       = logData[i];
      const rowTag    = (row[4]  || '').toString().trim();
      const qualified = (row[11] || '').toString().toLowerCase();
      const status    = (row[9]  || '').toString().toLowerCase();

      if (rowTag !== triggerTag) continue;
      if (qualified !== 'true')  continue;
      if (status === 'promoted') continue;

      const value = row[5] ? row[5].toString() : '';
      const notes = row[6] ? row[6].toString() : '';

      // task_done closes an existing TASKS row: entry value = task id (or an
      // exact-normalized title), notes = the evidence from the conversation.
      // The chat logs the event; THIS rule is the actuator — sheet-as-truth.
      // If the target task isn't found the entry stays unpromoted, so the
      // HEALTH unpromoted_tag check surfaces the broken closure instead of it
      // vanishing silently.
      if (promoteTo === 'task_done') {
        if (closeTaskFromEntry(ss, value, notes, now)) {
          logSheet.getRange(i + 1, 10).setValue('promoted');
        }
        continue;
      }

      // task/calendar promotions drain EVERY qualified entry — each is a
      // distinct item, so no early exit. State promotion keeps newest-wins
      // semantics: promote the most recent entry, then stop scanning.
      if (promoteTo === 'task' || promoteTo === 'calendar') {
        if (promoteTo === 'task') promoteToTask(ss, config, now, logKey, value, notes, context);
        else promoteToCalendar(ss, config, now, logKey, value, notes);
        logSheet.getRange(i + 1, 10).setValue('promoted');
        continue;
      }

      if (promoteTo !== 'log') writeStateKey(stateSheet, logKey, value, now, 'promotion');
      logSheet.getRange(i + 1, 10).setValue('promoted');
      break;
    }
  });
}

// Normalized-title equality — the guard against re-creating a task that's
// already open under trivially different punctuation/casing.
function normTitle(s) {
  return (s || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Close a TASKS row from a #task_done entry. Match by exact id first, then by
// exact-normalized title. Appends the evidence to notes so every closure is
// auditable back to the conversation that caused it. Idempotent.
function closeTaskFromEntry(ss, taskRef, evidence, now) {
  const tasksSheet = ss.getSheetByName('TASKS');
  if (!tasksSheet || !taskRef) return false;
  const data = tasksSheet.getDataRange().getValues();
  const ref  = taskRef.toString().trim();
  const refN = normTitle(ref);

  for (let i = 1; i < data.length; i++) {
    const idMatch    = (data[i][0] || '').toString().trim() === ref;
    const titleMatch = refN && normTitle(data[i][1]) === refN;
    if (!idMatch && !titleMatch) continue;

    if ((data[i][3] || '').toString().toLowerCase() !== 'done') {
      tasksSheet.getRange(i + 1, 3).setValue('done');
      tasksSheet.getRange(i + 1, 4).setValue('done');
      const prior = (data[i][5] || '').toString();
      const note  = 'closed via check-in' + (evidence ? ': ' + evidence : '') + ' [' + now.toISOString().split('T')[0] + ']';
      tasksSheet.getRange(i + 1, 6).setValue(prior ? prior + ' | ' + note : note);
    }
    return true; // already-done also counts as closed — idempotent
  }
  return false;
}

function promoteToTask(ss, config, now, title, value, notes, context) {
  const tasksSheet = ss.getSheetByName('TASKS');
  if (!tasksSheet) return;

  // Don't re-create a task that's already OPEN under the same normalized
  // title — reworded re-logs are the check-in's most common replay.
  const fullTitle = title + (value ? ': ' + value : '');
  const existing  = tasksSheet.getDataRange().getValues();
  for (let i = 1; i < existing.length; i++) {
    if ((existing[i][3] || '').toString().toLowerCase() === 'open' && normTitle(existing[i][1]) === normTitle(fullTitle)) return;
  }

  const ownerBday = config['owner_birthday'] || '1981-01-01';
  const daysAlive = Math.floor((now - new Date(ownerBday)) / 86400000);
  // Random suffix: several entries can drain in one run within the same ms.
  const id        = 'T' + now.getTime() + '_' + Math.floor(Math.random() * 1000);

  tasksSheet.appendRow([
    id,
    fullTitle,
    'open',
    'open',
    context || 'anywhere',
    notes,
    'type:task|priority:99',
    now.toISOString().split('T')[0]
  ]);
}

function promoteToCalendar(ss, config, now, key, value, notes) {
  const calSheet = ss.getSheetByName('CALENDAR');
  if (!calSheet) return;

  let dateStr = value;
  if (!dateStr || isNaN(new Date(dateStr).getTime())) {
    const future = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    dateStr = future.toISOString().split('T')[0];
  }

  const id = 'CAL' + now.getTime();
  calSheet.appendRow([
    id,
    key,
    dateStr,
    'active',
    'anywhere',
    notes,
    '{"notify_days_before":3,"tag":"#calendar"}',
    now.toISOString().split('T')[0]
  ]);
}

// ============================================================================
// HANDLER: SHEET_WRITE
//
// v3.4: when writing to LOG_RULES with new tag rows, auto-resolve matching
// VALIDATION_LOG entries so the growth loop closes cleanly.
// ============================================================================

function handleSheetWrite(params, ss, config, routeConfig) {
  const sheetName = params.sheet || routeConfig.sheet;
  const rows      = params.rows  || [];

  if (!sheetName) return { error: 'Missing sheet name' };
  if (PROTECTED_SHEETS.includes(sheetName)) return { error: 'Cannot write to protected sheet: ' + sheetName };

  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (params.headers && Array.isArray(params.headers)) {
      sheet.appendRow(params.headers);
      sheet.getRange('1:1').setFontWeight('bold').setBackground('#f0f0f0');
    }
  } else if (params.headers && Array.isArray(params.headers)) {
    ensureHeaders(sheet, params.headers);
  }

  let updated = 0, appended = 0;
  const newlyAddedTags = [];  // track for VALIDATION_LOG resolution

  rows.forEach(rowSpec => {
    const matchCol = rowSpec.match_column ? parseInt(rowSpec.match_column) : null;
    const matchVal = rowSpec.match_value != null ? rowSpec.match_value.toString() : null;
    const values   = rowSpec.values || {};

    if (rowSpec.action === 'delete' && matchCol && matchVal) {
      const data = sheet.getDataRange().getValues();
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i][matchCol - 1] != null &&
            data[i][matchCol - 1].toString().toLowerCase() === matchVal.toLowerCase()) {
          sheet.deleteRow(i + 1);
          updated++;
          break;
        }
      }
      return;
    }

    let found = false;
    if (matchCol && matchVal) {
      const data = sheet.getDataRange().getValues();
      for (let i = 0; i < data.length; i++) {
        if (data[i][matchCol - 1] != null &&
            data[i][matchCol - 1].toString().toLowerCase() === matchVal.toLowerCase()) {
          for (const [col, val] of Object.entries(values)) {
            const c = parseInt(col);
            if (!isNaN(c)) sheet.getRange(i + 1, c).setValue(val);
          }
          found = true;
          updated++;
          break;
        }
      }
    }

    if (!found) {
      const maxCol = Math.max(
        sheet.getLastColumn() || 1,
        ...Object.keys(values).map(k => parseInt(k)).filter(n => !isNaN(n))
      );
      const newRow = new Array(maxCol).fill('');
      for (const [col, val] of Object.entries(values)) {
        const c = parseInt(col);
        if (!isNaN(c) && c >= 1 && c <= maxCol) newRow[c - 1] = val;
      }
      sheet.appendRow(newRow);
      appended++;

      // v3.4: if we just appended a row to LOG_RULES, track the tag for
      // VALIDATION_LOG resolution. LOG_RULES col 1 is the tag.
      if (sheetName === 'LOG_RULES' && values['1']) {
        newlyAddedTags.push(values['1'].toString());
      }
    }
  });

  // v3.4: close the validation growth loop
  if (newlyAddedTags.length > 0) {
    markValidationResolvedForTags(ss, newlyAddedTags);
  }

  auditSession(ss, params, sheetName, updated, appended, config);
  return { status: 'success', sheet: sheetName, updated, appended, resolved_validations: newlyAddedTags.length };
}

// ============================================================================
// HANDLER: SHEET_READ
// ============================================================================

function handleSheetRead(params, ss, config, routeConfig) {
  const sheetName = params.sheet || routeConfig.sheet;
  if (!sheetName) return { error: 'Missing sheet name' };

  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: 'Sheet not found: ' + sheetName };

  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  let rows      = data.slice(1);

  if (params.active_only !== false) {
    const statusCol = headers.findIndex(h => h && h.toString().toLowerCase() === 'status');
    if (statusCol >= 0) {
      rows = rows.filter(r => !r[statusCol] || r[statusCol].toString().toLowerCase() !== 'inactive');
    }
  }

  if (params.filter) {
    const [col, val] = params.filter.split('=');
    const colIdx = headers.findIndex(h => h && h.toString().toLowerCase() === col.toLowerCase());
    if (colIdx >= 0) rows = rows.filter(r => r[colIdx] != null && r[colIdx].toString() === val);
  }

  const result = rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      if (h && row[i] !== undefined && row[i] !== null && row[i] !== '') {
        obj[h.toString().toLowerCase().replace(/[^a-z0-9_]/g, '_')] = row[i];
      }
    });
    return obj;
  });

  return { status: 'success', sheet: sheetName, count: result.length, rows: result };
}

// ============================================================================
// HANDLER: CONTEXT_BUILD
// ============================================================================

function handleContextBuild(params, ss, config, routeConfig) {
  if (routeConfig && routeConfig.mode === 'checkin') {
    return { prompt: getCheckinPrompt(ss, config) };
  }

  if (routeConfig && routeConfig.mode === 'checkin_detail') {
    return buildCheckinDetail(params, ss, config);
  }

  // ── LENS (T038): named view — narrow the sections, deepen the history past
  // the default context caps, optionally emit CSV. No lens = today's full packet
  // (backward compatible). Private lenses (person/funnel/history) expose deep
  // PERSONAL_LOG / CORRESPONDENCE content and REQUIRE the API token (?key=).
  const lens = resolveLens(params, ss);
  if (lens && lens.error) return { error: lens.error };
  if (lens && lens.private) {
    const lsec = getApiSecret(config);
    if (lsec && (params.key || '').toString() !== lsec) return { error: 'Unauthorized' };
  }

  const schemaSheet = ss.getSheetByName('CONTEXT_SCHEMA');
  if (!schemaSheet) return buildLegacyContext(params, ss, config);

  const schema = schemaSheet.getDataRange().getValues().slice(1)
    .filter(row => row[0] && row[1] && (row[6] || 'active') === 'active')
    .map(row => ({
      sheetName:   row[0],
      contextKey:  row[1],
      includeMode: row[2] || 'always',
      config:      safeParseJSON(row[3]) || {},
      maxRows:     row[4] ? parseInt(row[4]) : null,
      description: row[5] || '',
      status:      row[6] || 'active'
    }));

  const context  = {};
  const now      = new Date();
  const birthday = config['owner_birthday'] || '1981-01-01';
  const daysAlive= Math.floor((now - new Date(birthday)) / 86400000);

  schema.forEach(item => {
    if (item.status === 'inactive') return;
    // Lens section-narrowing: skip any context key the lens doesn't ask for.
    // This also skips the sheet read entirely — the efficiency win.
    if (lens && Array.isArray(lens.sections) && lens.sections.indexOf(item.contextKey) === -1) return;
    const sheet = ss.getSheetByName(item.sheetName);
    if (!sheet) return;

    const data    = sheet.getDataRange().getValues();
    if (data.length <= 1) { context[item.contextKey] = []; return; }

    const headers = data[0];
    let rows      = data.slice(1).filter(r => r[0] !== '' && r[0] !== null && r[0] !== undefined);

    const cfg = item.config;

    if (cfg.days_window) {
      const cutoff = daysAlive - parseInt(cfg.days_window);
      const daCol  = headers.findIndex(h => h && h.toString().toLowerCase() === 'days_alive');
      if (daCol >= 0) rows = rows.filter(r => parseInt(r[daCol]) >= cutoff);
    }

    if (cfg.status_filter) {
      const sCol = headers.findIndex(h => h && h.toString().toLowerCase() === 'status');
      if (sCol >= 0) rows = rows.filter(r => r[sCol] === cfg.status_filter);
    }

    if (cfg.sort_by) {
      const sCol = headers.findIndex(h => h && h.toString().toLowerCase() === cfg.sort_by);
      if (sCol >= 0) rows.sort((a, b) => (a[sCol] || 99) - (b[sCol] || 99));
    }

    if (cfg.dedupe_cols) {
      const seen = new Set();
      rows = rows.filter(r => {
        const key = cfg.dedupe_cols.map(c => {
          const ci = headers.findIndex(h => h && h.toString().toLowerCase() === c.toLowerCase());
          return ci >= 0 ? r[ci] : '';
        }).join('_');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    if (params.tags && headers.some(h => h && h.toString().toLowerCase() === 'tag')) {
      const tagCol  = headers.findIndex(h => h.toString().toLowerCase() === 'tag');
      const tagList = params.tags.split(',');
      rows = rows.filter(r => tagList.includes(r[tagCol]));
    }

    // Effective row cap: a lens cap override wins over the schema max_rows.
    let effMax = item.maxRows;
    if (lens && lens.caps) {
      if (lens.caps[item.contextKey] != null)  effMax = lens.caps[item.contextKey];
      else if (lens.caps._default != null)      effMax = lens.caps._default;
    }
    if (effMax && rows.length > effMax) rows = rows.slice(-effMax);

    if (headers[0] && headers[0].toString() === 'Key' && headers[1] && headers[1].toString() === 'Value') {
      const kv = {};
      rows.forEach(r => {
        if (!r[0]) return;
        const k = r[0].toString();
        if (isSecretKey(k)) return; // never let secrets leave the backend in a context packet
        kv[k] = r[1] != null ? r[1].toString() : '';
      });
      context[item.contextKey] = kv;
    } else {
      context[item.contextKey] = rows.map(row => {
        const obj = {};
        headers.forEach((h, i) => {
          if (h && row[i] !== undefined && row[i] !== null && row[i] !== '') {
            obj[h.toString().toLowerCase().replace(/[^a-z0-9_]/g, '_')] = row[i];
          }
        });
        return obj;
      });
    }
  });

  // Computed sections — gated by the lens section list (a narrow lens like
  // person/funnel/history shouldn't drag in calendar/partner noise). The cycle
  // and presence state syncs still run (they're a side effect of the read).
  const wants = (k) => !lens || !Array.isArray(lens.sections) || lens.sections.indexOf(k) >= 0;

  const calAlerts = buildCalendarAlerts(ss, daysAlive);
  if (calAlerts.length > 0 && wants('calendar_alerts')) context['calendar_alerts'] = calAlerts;

  const pc = computePartnerCycle(ss, config);
  if (pc) { syncPartnerCycleToState(ss, pc); if (wants('partner_cycle_live')) context['partner_cycle_live'] = pc; }

  const presence = computePartnerPresence(ss, config);
  if (presence) { syncPresenceToState(ss, presence); if (wants('partner_presence')) context['partner_presence'] = presence; }

  // ── LENS post-processing (T038): semantic filters + deep history ──────────
  if (lens) applyLens(context, lens, ss, config, params, daysAlive);

  context._meta = {
    generated:    now.toISOString(),
    days_alive:   daysAlive,
    owner_name:   config['owner_name']   || '',
    owner_id:     config['owner_id']     || '',
    partner_name: config['partner_name'] || '',
    partner_id:   config['partner_id']   || '',
    lens:         lens ? lens._name : undefined,
    version:      '3.4'
  };

  // CSV output — emit the primary tabular section as raw CSV (doGet detects _csv).
  if (lens && (params.format || '').toString().toLowerCase() === 'csv') {
    const table = context.log_history || context.correspondence || context.logs || context.leads || [];
    return { _csv: toCsv(table), _rows: table.length };
  }

  return context;
}

// ============================================================================
// CONTEXT LENSES (T038)
//
// A lens is a named view over the context packet: it narrows which sections are
// assembled, deepens the log/correspondence history past the default context
// caps, and can emit CSV. Built-in defaults live in BUILTIN_LENSES; a
// CONTEXT_LENSES sheet row of the same name overrides any field (sheet-driven,
// per the north star — code default is the fallback so it works pre-provision).
//
// Private lenses expose deep PERSONAL_LOG / CORRESPONDENCE content and REQUIRE
// the API token (?key=) — the gate lives at the top of handleContextBuild.
//
// Lens fields:
//   sections        array of context keys to include (null/'*' = all schema keys)
//   caps            { <contextKey>: maxRows, _default: maxRows } cap overrides
//   log_exclude     tags dropped from the `logs` section (e.g. #notification)
//   health_bad_only keep only STALE/FAIL rows in `health`
//   deep            { log:{by:'person'|'filter'|'all', cap}, correspondence:{cap} }
//   private         bool — require the API token
//   needs           required runtime params (e.g. ['who'])
// ============================================================================

var BUILTIN_LENSES = {
  // Everything the nightly brief actually reads — replaces the worker's
  // hardcoded trimContext with a declarative, sheet-tunable section list.
  brief: {
    sections: ['current_state', 'tasks', 'calendar', 'calendar_alerts', 'partner_state',
               'partner_cycle_live', 'partner_presence', 'leads', 'people', 'health', 'logs'],
    caps: { logs: 25, people: 40, leads: 30 },
    log_exclude: ['#notification'],
    health_bad_only: true,
    private: false
  },
  // The conversational check-in view (floyd-chat).
  checkin: {
    sections: ['current_state', 'tasks', 'calendar', 'calendar_alerts', 'partner_state',
               'partner_presence', 'leads', 'health', 'logs'],
    caps: { logs: 30, leads: 30 },
    log_exclude: ['#notification'],
    health_bad_only: true,
    private: false
  },
  // Call-prep for one person: their PEOPLE row + deep log history + full
  // correspondence trail. Private (per-person content).
  person: {
    sections: ['people'],
    needs: ['who'],
    deep: { log: { by: 'person', cap: 400 }, correspondence: { cap: 200 } },
    private: true
  },
  // The whole funnel: pipeline + people + traffic state + correspondence.
  funnel: {
    sections: ['leads', 'people', 'current_state'],
    caps: { people: 60, leads: 60 },
    deep: { correspondence: { cap: 200 } },
    private: true
  },
  // Free-form history query by tags and/or day window — NO row cap, so the MCP
  // can search the whole log beyond the ~50-row context window.
  history: {
    sections: [],
    deep: { log: { by: 'filter', cap: null } },
    private: true
  }
};

// Resolve a lens spec: code default, overridden by a CONTEXT_LENSES row, with
// required-param validation. Returns null (no/unknown lens → full build),
// { error } (bad request), or the spec (with _name).
function resolveLens(params, ss) {
  const name = (params.lens || '').toString().trim();
  if (!name) return null;

  let spec = BUILTIN_LENSES[name] ? JSON.parse(JSON.stringify(BUILTIN_LENSES[name])) : null;

  const sheet = ss.getSheetByName('CONTEXT_LENSES');
  if (sheet) {
    const data = sheet.getDataRange().getValues();
    const head = (data[0] || []).map(h => h.toString().toLowerCase().trim());
    const li   = head.indexOf('lens');
    if (li >= 0) {
      for (let r = 1; r < data.length; r++) {
        if ((data[r][li] || '').toString().trim() !== name) continue;
        spec = spec || {};
        const raw = (col) => { const i = head.indexOf(col); return i >= 0 ? data[r][i] : undefined; };
        const has = (col) => { const v = raw(col); return v !== undefined && v !== ''; };
        const asList = (col) => raw(col).toString().split(',').map(s => s.trim()).filter(Boolean);
        const asBool = (col) => /^(1|true|yes)$/i.test(raw(col).toString().trim());
        if (has('sections'))        { const l = asList('sections'); spec.sections = (l[0] === '*') ? null : l; }
        if (has('caps'))            spec.caps = safeParseJSON(raw('caps').toString());
        if (has('log_exclude'))     spec.log_exclude = asList('log_exclude');
        if (has('health_bad_only')) spec.health_bad_only = asBool('health_bad_only');
        if (has('deep'))            spec.deep = safeParseJSON(raw('deep').toString());
        if (has('private'))         spec.private = asBool('private');
        if (has('needs'))           spec.needs = asList('needs');
        break;
      }
    }
  }

  if (!spec) return null;  // unknown lens name → ignore, full build

  const needs = spec.needs || [];
  for (let i = 0; i < needs.length; i++) {
    if (!(params[needs[i]] || '').toString().trim()) {
      return { error: "lens '" + name + "' requires param '" + needs[i] + "'" };
    }
  }
  if (name === 'history' && !(params.tags || params.days)) {
    return { error: "lens 'history' requires 'tags' and/or 'days'" };
  }

  spec._name = name;
  return spec;
}

// Apply lens semantics after the base packet is built: exclude noise tags from
// logs, trim health to problems, filter people to the target person, and attach
// deep log/correspondence history that bypasses the context row caps.
function applyLens(context, lens, ss, config, params, daysAlive) {
  if (Array.isArray(lens.log_exclude) && lens.log_exclude.length && Array.isArray(context.logs)) {
    const drop = lens.log_exclude;
    context.logs = context.logs.filter(l => drop.indexOf((l.tag || l.Tag || '').toString()) === -1);
    const cap = lens.caps && lens.caps.logs;
    if (cap && context.logs.length > cap) context.logs = context.logs.slice(-cap);
  }

  if (lens.health_bad_only && Array.isArray(context.health)) {
    context.health = context.health.filter(h => h.status === 'STALE' || h.status === 'FAIL');
  }

  // Person lens: narrow the people section to the target.
  if (lens._name === 'person' && Array.isArray(context.people)) {
    const who = (params.who || '').toString().toLowerCase();
    context.people = context.people.filter(p =>
      (p.id || '').toString().toLowerCase() === who ||
      (p.name || '').toString().toLowerCase() === who);
  }

  if (lens.deep) {
    if (lens.deep.log) {
      const dl   = lens.deep.log;
      const opts = { cap: dl.cap };
      if (dl.by === 'person') opts.person = params.who;
      if (dl.by === 'filter')  { opts.tags = params.tags; opts.days = params.days; }
      context.log_history = deepLogScan(ss, config, opts);
    }
    if (lens.deep.correspondence) {
      const who = (lens.deep.log && lens.deep.log.by === 'person') ? params.who : (params.who || '');
      context.correspondence = deepCorrespondence(ss, who, lens.deep.correspondence.cap);
    }
  }
}

// Deep PERSONAL_LOG scan — bypasses the context 50-row cap. Filters by person,
// tags (CSV), and/or a day window; cap=null returns the whole matching history.
function deepLogScan(ss, config, opts) {
  const sheet = ss.getSheetByName('PERSONAL_LOG');
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0];
  const lc = h => h.toString().toLowerCase();
  const personCol = headers.findIndex(h => lc(h) === 'person');
  const tagCol    = headers.findIndex(h => lc(h) === 'tag');
  const daCol     = headers.findIndex(h => lc(h) === 'days_alive');
  let rows = data.slice(1).filter(r => r[0] !== '' && r[0] !== null && r[0] !== undefined);

  if (opts.person && personCol >= 0) {
    const who = opts.person.toString().toLowerCase();
    rows = rows.filter(r => (r[personCol] || '').toString().toLowerCase() === who);
  }
  if (opts.tags && tagCol >= 0) {
    const list = opts.tags.toString().split(',').map(s => s.trim()).filter(Boolean);
    if (list.length) rows = rows.filter(r => list.indexOf((r[tagCol] || '').toString()) >= 0);
  }
  if (opts.days && daCol >= 0) {
    const cutoff = daysAliveFor(config) - parseInt(opts.days);
    rows = rows.filter(r => parseInt(r[daCol]) >= cutoff);
  }
  if (opts.cap && rows.length > opts.cap) rows = rows.slice(-opts.cap);

  return rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      if (h && row[i] !== undefined && row[i] !== null && row[i] !== '') {
        obj[h.toString().toLowerCase().replace(/[^a-z0-9_]/g, '_')] = row[i];
      }
    });
    return obj;
  });
}

function daysAliveFor(config) {
  const bday = config['owner_birthday'] || '1981-01-01';
  return Math.floor((new Date() - new Date(bday)) / 86400000);
}

// Deep CORRESPONDENCE pull for one person (person='' → all captured people).
function deepCorrespondence(ss, person, cap) {
  const cs = ss.getSheetByName('CORRESPONDENCE');
  if (!cs) return [];
  const last = cs.getLastRow();
  if (last < 2) return [];
  const head = cs.getRange(1, 1, 1, cs.getLastColumn()).getValues()[0];
  const vals = cs.getRange(2, 1, last - 1, cs.getLastColumn()).getValues();
  let mapped = vals.map(r => { const o = {}; head.forEach((h, i) => { o[h || ('col' + (i + 1))] = r[i]; }); return o; });
  const p = (person || '').toString().trim();
  if (p) mapped = mapped.filter(o => (o.person_id || '').toString() === p);
  if (cap && mapped.length > cap) mapped = mapped.slice(-cap);
  return mapped;
}

// Array-of-objects → CSV (union of keys, RFC-4180 quoting).
function toCsv(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const cols = [];
  rows.forEach(r => Object.keys(r).forEach(k => { if (cols.indexOf(k) < 0) cols.push(k); }));
  const esc = v => {
    const s = (v === null || v === undefined) ? '' : v.toString();
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  rows.forEach(r => lines.push(cols.map(c => esc(r[c])).join(',')));
  return lines.join('\n');
}

// Provision the CONTEXT_LENSES sheet with the built-in lenses as editable rows
// (idempotent). Lets Peter tune lenses from the sheet without touching code.
function ensureLensesSheet(ss) {
  let s = ss.getSheetByName('CONTEXT_LENSES');
  const header = ['lens', 'sections', 'caps', 'log_exclude', 'health_bad_only', 'deep', 'private', 'needs', 'description'];
  if (!s) {
    s = ss.insertSheet('CONTEXT_LENSES');
    s.appendRow(header);
    s.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#f0f0f0');
    const seed = [
      ['brief',   'current_state,tasks,calendar,calendar_alerts,partner_state,partner_cycle_live,partner_presence,leads,people,health,logs', '{"logs":25,"people":40,"leads":30}', '#notification', 'yes', '', 'no',  '',    'Nightly brief view'],
      ['checkin', 'current_state,tasks,calendar,calendar_alerts,partner_state,partner_presence,leads,health,logs', '{"logs":30,"leads":30}', '#notification', 'yes', '', 'no', '', 'Conversational check-in view'],
      ['person',  'people', '', '', 'no', '{"log":{"by":"person","cap":400},"correspondence":{"cap":200}}', 'yes', 'who', 'Call-prep for one person (deep log + correspondence)'],
      ['funnel',  'leads,people,current_state', '{"people":60,"leads":60}', '', 'no', '{"correspondence":{"cap":200}}', 'yes', '', 'Whole funnel: pipeline + people + correspondence'],
      ['history', '', '', '', 'no', '{"log":{"by":"filter","cap":null}}', 'yes', '', 'Free-form log history by tags/days, no cap'],
    ];
    seed.forEach(r => s.appendRow(r));
    s.autoResizeColumns(1, header.length);
    return { created: true, rows: seed.length };
  }
  return { created: false };
}

// ============================================================================
// CHECKIN DETAIL — on-demand full data for AI context requests
//
// v3.4: adds 'validation_errors' detail type for growth feedback loop
// ============================================================================

function buildCheckinDetail(params, ss, config) {
  const ownerBday = config['owner_birthday'] || '1981-01-01';
  const now       = new Date();
  const todayDa   = Math.floor((now - new Date(ownerBday)) / 86400000);
  const cutoff30  = todayDa - 30;
  const detail    = (params.detail || 'unqualified').toString().toLowerCase();

  if (detail === 'unqualified') {
    const logSheet = ss.getSheetByName('PERSONAL_LOG');
    if (!logSheet) return { unqualified: [] };
    const logData     = logSheet.getDataRange().getValues().slice(1).filter(r => r[0]);
    const freshUnqual = [];
    logData.forEach(r => {
      const da        = parseInt(r[0]);
      const tag       = (r[4] || '').toString();
      const qualified = (r[11] || '').toString().toLowerCase();
      const status    = (r[9]  || '').toString().toLowerCase();
      if (tag === '#unresolved') return;
      if (status === 'promoted') return;
      if (qualified === 'false' && da >= cutoff30) {
        freshUnqual.push({
          id: r[2], days_alive: da, tag, value: r[5] ? r[5].toString() : '', notes: r[6] ? r[6].toString() : ''
        });
      }
    });
    return { detail: 'unqualified', count: freshUnqual.length, entries: freshUnqual };
  }

  if (detail === 'dormant') {
    const logSheet = ss.getSheetByName('PERSONAL_LOG');
    if (!logSheet) return { dormant: [] };
    const logData    = logSheet.getDataRange().getValues().slice(1).filter(r => r[0]);
    const dormant    = [];
    logData.forEach(r => {
      const tag = (r[4] || '').toString();
      if (tag === '#unresolved') {
        dormant.push({
          id: r[2], days_alive: parseInt(r[0]), tag, value: r[5] ? r[5].toString() : '', notes: r[6] ? r[6].toString() : ''
        });
      }
    });
    return { detail: 'dormant', count: dormant.length, entries: pickRandom(dormant, 3) };
  }

  if (detail === 'tasks') {
    const tasksSheet = ss.getSheetByName('TASKS');
    if (!tasksSheet) return { tasks: [] };
    const data    = tasksSheet.getDataRange().getValues();
    const headers = data[0];
    const rows    = data.slice(1).filter(r => r[0] && r[3] === 'open').map(row => {
      const obj = {};
      headers.forEach((h, i) => { if (h) obj[h.toString().toLowerCase()] = row[i]; });
      return obj;
    });
    return { detail: 'tasks', count: rows.length, tasks: rows };
  }

  // v3.4: new detail type for validation growth loop
  if (detail === 'validation_errors') {
    return buildValidationErrorsDetail(ss);
  }

  return { error: 'Unknown detail type: ' + detail };
}

// ============================================================================
// VALIDATION GROWTH LOOP — surfaces unresolved VALIDATION_LOG entries
// grouped by error pattern so AI can propose fixes during checkin
// ============================================================================

function buildValidationErrorsDetail(ss) {
  const vlSheet = ss.getSheetByName('VALIDATION_LOG');
  if (!vlSheet) return { detail: 'validation_errors', count: 0, groups: [] };

  const data = vlSheet.getDataRange().getValues();
  if (data.length <= 1) return { detail: 'validation_errors', count: 0, groups: [] };

  // Unresolved = anything not explicitly marked 'true' / 'TRUE' / true in col 6
  const unresolved = data.slice(1).filter(r => {
    if (!r[VL_COL_TIMESTAMP - 1]) return false;
    const resolved = (r[VL_COL_RESOLVED - 1] || '').toString().toLowerCase();
    return resolved !== 'true';
  });

  if (unresolved.length === 0) {
    return { detail: 'validation_errors', count: 0, groups: [] };
  }

  // Group by error pattern to suggest concrete growth actions
  const groups = {};

  unresolved.forEach(r => {
    const message = (r[VL_COL_MESSAGE - 1] || '').toString();
    const entryRaw = (r[VL_COL_ENTRY - 1] || '').toString();
    const ai = (r[VL_COL_AI - 1] || '').toString();
    const timestamp = (r[VL_COL_TIMESTAMP - 1] || '').toString();

    // Extract the attempted tag from the entry JSON if possible
    let attemptedTag = null;
    const tagMatch = entryRaw.match(/"tag"\s*:\s*"([^"]+)"/);
    if (tagMatch) attemptedTag = tagMatch[1];

    // Classify error
    let classification = 'other';
    let groupKey = 'other:' + message.substring(0, 50);

    if (/Invalid tag:/.test(message)) {
      classification = 'invalid_tag';
      groupKey = 'invalid_tag:' + (attemptedTag || 'unknown');
    } else if (/Missing tag/.test(message)) {
      classification = 'missing_tag';
      groupKey = 'missing_tag';
    } else if (/Missing type/.test(message)) {
      classification = 'missing_type';
      groupKey = 'missing_type';
    } else if (/Missing value/.test(message)) {
      classification = 'missing_value';
      groupKey = 'missing_value';
    } else if (/already exists/.test(message)) {
      classification = 'duplicate_key';
      groupKey = 'duplicate_key:' + (message.match(/"([^"]+)"/) || [])[1];
    } else if (/Invalid type/.test(message)) {
      classification = 'invalid_type';
      groupKey = 'invalid_type:' + (message.match(/Invalid type:\s*(\S+)/) || [])[1];
    }

    if (!groups[groupKey]) {
      groups[groupKey] = {
        classification,
        pattern: message.substring(0, 120),
        attempted_tag: attemptedTag,
        count: 0,
        ais: new Set(),
        first_seen: timestamp,
        last_seen: timestamp,
        sample_entry: entryRaw.substring(0, 200),
        suggested_action: null
      };
    }

    const g = groups[groupKey];
    g.count++;
    if (ai) g.ais.add(ai);
    if (timestamp > g.last_seen) g.last_seen = timestamp;
    if (timestamp < g.first_seen) g.first_seen = timestamp;
  });

  // Add suggested actions per group and convert Set to array
  Object.values(groups).forEach(g => {
    g.ais = Array.from(g.ais);

    switch (g.classification) {
      case 'invalid_tag':
        g.suggested_action = g.attempted_tag
          ? 'Add ' + g.attempted_tag + ' to LOG_RULES, or retag past attempts.'
          : 'Review and decide on tag.';
        break;
      case 'missing_tag':
        g.suggested_action = 'AI sent packet without tag field. Prompt template may be wrong.';
        break;
      case 'missing_type':
      case 'invalid_type':
        g.suggested_action = 'Old packet format (pre-v3). AI needs updated schema.';
        break;
      case 'duplicate_key':
        g.suggested_action = 'Promotion target already existed. Upsert path worked — safe to mark resolved.';
        break;
      default:
        g.suggested_action = 'Review entry and decide.';
    }
  });

  const groupArray = Object.values(groups).sort((a, b) => b.count - a.count);

  return {
    detail: 'validation_errors',
    count: unresolved.length,
    group_count: groupArray.length,
    groups: groupArray
  };
}

function markValidationResolvedForTags(ss, tags) {
  const vlSheet = ss.getSheetByName('VALIDATION_LOG');
  if (!vlSheet) return 0;

  const data = vlSheet.getDataRange().getValues();
  let resolved = 0;

  const tagsLower = tags.map(t => t.toString().toLowerCase());

  for (let i = 1; i < data.length; i++) {
    const currentResolved = (data[i][VL_COL_RESOLVED - 1] || '').toString().toLowerCase();
    if (currentResolved === 'true') continue;

    const message = (data[i][VL_COL_MESSAGE - 1] || '').toString();
    const entryRaw = (data[i][VL_COL_ENTRY - 1] || '').toString();

    // Match if this row's error is about one of the tags we just registered
    const matchesTag = tagsLower.some(tag => {
      const inMessage = message.toLowerCase().includes(tag.toLowerCase());
      const inEntry = entryRaw.toLowerCase().includes('"tag":"' + tag.toLowerCase() + '"');
      return /invalid tag:/i.test(message) && (inMessage || inEntry);
    });

    if (matchesTag) {
      vlSheet.getRange(i + 1, VL_COL_RESOLVED).setValue('true');
      resolved++;
    }
  }

  return resolved;
}

// ============================================================================
// HANDLER: SCORER
// ============================================================================

function handleScorer(params, ss, config, routeConfig) {
  const text        = (params.text || '').toString();
  const scorerSheet = routeConfig.sheet || 'TAG_KEYWORDS';
  if (!text) return { tag: '#note', score: 0, confident: false };

  const sheet = ss.getSheetByName(scorerSheet);
  if (!sheet) return { tag: '#note', score: 0, confident: false };

  const lower  = text.toLowerCase();
  const rows   = sheet.getDataRange().getValues().slice(1);
  let best     = { tag: '#note', score: 0, confident: false };
  let topScore = 0;
  let tied     = false;

  rows.forEach(row => {
    const tag      = (row[0] || '').toString().trim();
    if (!tag || !tag.startsWith('#')) return;
    const keywords = (row[1] || '').toString().split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    const priority = parseFloat(row[2]) || 1;

    let hits = 0;
    keywords.forEach(kw => { if (kw && lower.includes(kw)) hits++; });
    const score = hits * priority;

    if (score > topScore) {
      topScore = score; tied = false;
      best = { tag, score, confident: hits >= 1 };
    } else if (score === topScore && score > 0) {
      tied = true;
    }
  });

  if (tied || topScore === 0) return { tag: '#note', score: topScore, confident: false };
  return best;
}

// ============================================================================
// HANDLER: STATE_UPDATE
// ============================================================================

function handleStateUpdate(key, params, ss, config) {
  const now        = new Date();
  const ownerId    = config['owner_id']       || 'owner';
  const ownerBday  = config['owner_birthday'] || '1981-01-01';
  const daysAlive  = Math.floor((now - new Date(ownerBday)) / 86400000);
  const stateSheet = ss.getSheetByName('SYSTEM_STATE');

  writeStateKey(stateSheet, key, params.value, now, params.source || 'dashboard');

  const rulesSheet = ss.getSheetByName('PROMOTION_RULES');
  if (rulesSheet) {
    const rules = rulesSheet.getDataRange().getValues().slice(1);
    for (const rule of rules) {
      if (rule[0] === key && (rule[3] === true || rule[3] === 'TRUE' || rule[3] === 'true' || rule[3] === 'active')) {
        const person = rule[2] === 'owner' ? ownerId : (config['partner_id'] || 'partner');
        const id     = 'D' + key + '_' + now.getTime();
        ss.getSheetByName('PERSONAL_LOG').appendRow([
          daysAlive, now.toISOString(), id, person, rule[1],
          params.value ? params.value.toString() : '',
          params.notes || 'updated from dashboard', '',
          'dashboard', 'active', 1, 'false'
        ]);
        applyLogRules(ss, rule[1]);
        break;
      }
    }
  }

  return { status: 'success', key };
}

// ============================================================================
// EVOLUTION LOOP — proposal executor (the "apply half"; see EVOLUTION_LOOP.md)
//
// A PROPOSALS row carries a whitelisted mutation packet. applyProposal() checks
// it against the op whitelist + the never-auto blocklist, then performs the
// mutation through the SAME proven write helpers (handleSheetWrite / writeStateKey)
// — no new write surface. It is a whitelist DISPATCHER, not an eval: Floyd can
// only compose pre-approved verbs; a new op is a deliberate code change. Idempotent:
// re-applying an already-applied row is a no-op (matches the gateway idempotency).
//
// Called two ways, both already token-gated by the POST auth gate in dispatch():
//   • auto  (reflection worker)  → params.auto === true  → blocklist is strict
//   • tap   (Peter, via the hub) → params.auto !== true  → consent for tap-gated ops
// ============================================================================

// Verbs the executor will compose. Anything else is refused.
var PROPOSAL_OPS      = ['add_tag', 'add_card', 'track_metric', 'retire_flag', 'propose_coach', 'set_config'];
// Verbs that MAY be auto-applied (machine, no human tap). Subject to the guards below.
var PROPOSAL_AUTO_OPS = ['add_tag', 'add_card', 'retire_flag', 'propose_coach'];

// Tags that drive computed/financial/cycle state — never created or mutated by a packet.
function isProtectedTag(tag) {
  var t = String(tag || '').toLowerCase();
  return t === '#balance' || t === '#odometer' || t === '#cycle' || t.indexOf('#cycle_') === 0;
}

function stateKeyExists(ss, key) {
  var s = ss.getSheetByName('SYSTEM_STATE');
  if (!s) return false;
  var d = s.getDataRange().getValues();
  for (var i = 1; i < d.length; i++) { if (d[i][0] && d[i][0].toString() === key) return true; }
  return false;
}

function applyProposal(params, ss, config) {
  var id = (params.id || '').toString().trim();
  if (!id) return { error: 'apply_proposal: missing id' };
  var isAuto = params.auto === true || params.auto === 'true';

  var sheet = ss.getSheetByName('PROPOSALS');
  if (!sheet) return { error: 'PROPOSALS sheet not found — run ensureProposalsSheet()' };
  var data = sheet.getDataRange().getValues();
  var rowIdx = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString() === id) { rowIdx = i; break; }
  }
  if (rowIdx < 0) return { error: 'proposal not found: ' + id };

  var status = (data[rowIdx][7] || 'proposed').toString().toLowerCase();
  // Idempotent: already applied → no-op (safe to retry).
  if (status === 'applied') {
    return { ok: true, id: id, status: 'applied', result: (data[rowIdx][9] || '').toString(), replay: true };
  }
  if (status === 'rejected' || status === 'expired') return { error: 'proposal ' + status + ': ' + id };

  var packet = safeParseJSON(data[rowIdx][5]);
  if (!packet || !packet.op) return { error: 'proposal has no valid packet' };
  if (PROPOSAL_OPS.indexOf(packet.op) < 0) return { error: 'op not in whitelist: ' + packet.op };

  // Never-auto blocklist: refuse tap-only ops on the AUTO path even if the packet
  // mislabels itself risk:auto. (Per-op security guards live in executeProposalPacket.)
  if (isAuto && PROPOSAL_AUTO_OPS.indexOf(packet.op) < 0) {
    return { error: 'op ' + packet.op + ' is tap-only — cannot auto-apply' };
  }

  var now = new Date();
  var out;
  try {
    out = executeProposalPacket(packet, ss, config, now, isAuto);
  } catch (e) {
    // Leave status unchanged so it can be inspected/retried; record the error.
    sheet.getRange(rowIdx + 1, 10).setValue('ERROR: ' + (e.message || e));
    return { error: (e.message || e).toString(), id: id };
  }

  sheet.getRange(rowIdx + 1, 8).setValue('applied');
  sheet.getRange(rowIdx + 1, 9).setValue(now.toISOString());
  sheet.getRange(rowIdx + 1, 10).setValue(JSON.stringify(out).slice(0, 480));
  return { ok: true, id: id, op: packet.op, result: out };
}

// Whitelist dispatcher. Each verb maps to an existing proven write path; the
// per-op guards here are the security half of the never-auto blocklist.
function executeProposalPacket(packet, ss, config, now, isAuto) {
  switch (packet.op) {

    case 'add_tag': {
      var tag = (packet.tag || '').toString().trim();
      if (!tag || tag.charAt(0) !== '#') throw new Error('add_tag: tag must start with #');
      if (isProtectedTag(tag)) throw new Error('add_tag: ' + tag + ' is protected');
      // LOG_RULES upsert by tag (col1). 'keep'/'forever' is the safe default retention.
      handleSheetWrite({ sheet: 'LOG_RULES', ai: 'evolution', rows: [{
        match_column: 1, match_value: tag,
        values: { '1': tag, '2': packet.retention || 'forever', '4': packet.action || 'keep' }
      }] }, ss, config, {});
      var added = { log_rule: tag };
      // Optional keyword seeding so the scorer can auto-route text to the new tag.
      var kw = Array.isArray(packet.keywords) ? packet.keywords.join(', ') : (packet.keywords || '');
      if (kw) {
        handleSheetWrite({ sheet: 'TAG_KEYWORDS', ai: 'evolution', rows: [{
          match_column: 1, match_value: tag,
          values: { '1': tag, '2': kw, '3': String(packet.priority || 1) }
        }] }, ss, config, {});
        added.keywords = kw;
      }
      return added;
    }

    case 'add_card': {
      var key = (packet.source_key || packet.key || '').toString().trim();
      if (!key) throw new Error('add_card: source_key required');
      if (isSecretKey(key)) throw new Error('add_card: refusing secret key ' + key);
      // Auto path may only surface an ALREADY-tracked state key (no new surface area).
      if (isAuto && !stateKeyExists(ss, key)) throw new Error('add_card: source_key not tracked — tap required');
      // DISPLAY_CONFIG cols: key | label | modes | condition | priority | editable | edit_key.
      handleSheetWrite({ sheet: 'DISPLAY_CONFIG', ai: 'evolution', rows: [{
        match_column: 1, match_value: key,
        values: { '1': key, '2': packet.title || key, '3': packet.modes || 'all',
                  '4': packet.condition || 'always', '5': String(packet.priority || 50) }
      }] }, ss, config, {});
      return { card: key, label: packet.title || key };
    }

    case 'track_metric': {
      if (isAuto) throw new Error('track_metric is tap-only (new surface area)');
      var mkey = (packet.key || '').toString().trim();
      if (!mkey) throw new Error('track_metric: key required');
      if (isSecretKey(mkey)) throw new Error('track_metric: refusing secret key ' + mkey);
      writeStateKey(ss.getSheetByName('SYSTEM_STATE'), mkey, packet.seed != null ? packet.seed : '', now, 'evolution');
      var res = { metric: mkey, seed: packet.seed != null ? packet.seed : '' };
      if (packet.card && typeof packet.card === 'object') {
        res.card = executeProposalPacket({
          op: 'add_card', source_key: packet.card.source_key || mkey, title: packet.card.title,
          modes: packet.card.modes, condition: packet.card.condition, priority: packet.card.priority
        }, ss, config, now, false);
      }
      return res;
    }

    case 'retire_flag': {
      var rkey = (packet.key || '').toString().trim();
      if (!rkey) throw new Error('retire_flag: key required');
      if (isSecretKey(rkey)) throw new Error('retire_flag: refusing secret key ' + rkey);
      // API can't DELETE rows — tombstone the value (spec §2). No row deletes, ever.
      writeStateKey(ss.getSheetByName('SYSTEM_STATE'), rkey, 'retired', now, 'evolution');
      return { retired: rkey };
    }

    case 'propose_coach': {
      var ckey = (packet.key || '').toString().trim().toLowerCase();
      if (!ckey) throw new Error('propose_coach: key required');
      var projects = loadSheet(ss, 'PROJECTS');
      for (var p = 0; p < projects.length; p++) {
        if (String(projects[p].key || '').toLowerCase() === ckey) throw new Error('propose_coach: project exists: ' + ckey);
      }
      // Reuse the existing PROJECTS proposed→/activate flow (floyd-checkin activates).
      var meta = (packet.meta && typeof packet.meta === 'object') ? packet.meta : {};
      meta.activate_code = Math.random().toString(36).slice(2, 8);
      if (meta.last_nudge === undefined) meta.last_nudge = null;
      var pid = 'PRJ_' + ckey;
      handleSheetWrite({ sheet: 'PROJECTS', ai: 'evolution',
        headers: ['id', 'key', 'value', 'status', 'context', 'notes', 'meta', 'updated'],
        rows: [{ match_column: 1, match_value: pid, values: {
          '1': pid, '2': ckey, '3': packet.goal || meta.goal || ckey, '4': 'proposed',
          '5': ckey, '6': 'Proposed coach — awaiting activation', '7': JSON.stringify(meta), '8': now.toISOString()
        } }] }, ss, config, {});
      return { proposed_coach: ckey };
    }

    case 'set_config': {
      if (isAuto) throw new Error('set_config is tap-only (NEVER auto)');
      var sk = (packet.key || '').toString().trim();
      if (!sk) throw new Error('set_config: key required');
      if (isSecretKey(sk)) throw new Error('set_config: refusing secret key ' + sk);
      // CONFIG cols: key | value.
      handleSheetWrite({ sheet: 'CONFIG', ai: 'evolution', rows: [{
        match_column: 1, match_value: sk, values: { '1': sk, '2': packet.value != null ? packet.value : '' }
      }] }, ss, config, {});
      return { config: sk, value: packet.value };
    }

    default:
      throw new Error('unhandled op: ' + packet.op);
  }
}

// Bootstrap the evolution loop on an EXISTING deployment: create the PROPOSALS tab
// + register its read route. (initFloydV3 covers fresh installs.) Idempotent — run
// once from the Apps Script editor after pushing this version. apply_proposal needs
// no route row: it is a special dispatch branch.
function ensureProposalsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName('PROPOSALS')) {
    var s = ss.insertSheet('PROPOSALS');
    s.appendRow(['id', 'created', 'source', 'type', 'summary', 'packet', 'risk', 'status', 'applied', 'result']);
    s.getRange('A1:J1').setFontWeight('bold').setBackground('#f0f0f0');
    s.autoResizeColumns(1, 10);
  }
  var rr = ss.getSheetByName('ROUTE_REGISTRY');
  if (rr) {
    var rows = rr.getDataRange().getValues();
    var haveP = rows.some(function (r) { return r[0] === 'proposals'     && (r[1] || '').toString().toUpperCase() === 'GET'; });
    var haveE = rows.some(function (r) { return r[0] === 'evolution_read' && (r[1] || '').toString().toUpperCase() === 'GET'; });
    if (!haveP) rr.appendRow(['proposals',     'GET', 'sheet_read', '{"sheet":"PROPOSALS"}',     'active', 'Read evolution proposals']);
    if (!haveE) rr.appendRow(['evolution_read', 'GET', 'sheet_read', '{"sheet":"EVOLUTION_LOG"}', 'active', 'Read the free-text idea stream']);
  }
  return { ok: true, sheet: 'PROPOSALS' };
}

// ============================================================================
// HEALTH — sheet-driven self-verification (v3.6)
//
// The trap this kills: features that capture + surface but never close their
// loop (writes that no rule reads, heartbeats that die silently). HEALTH is a
// registry: one row = one check. New feature → new row. The evaluator is
// generic and LLM-free; it runs on the existing nightly trigger and via
// run_setup. Results ride into the context packet through CONTEXT_SCHEMA, so
// every agent (brief, reflection, chat) sees system health for zero extra cost.
//
// Check types:
//   state_stale     target=SYSTEM_STATE key         threshold=max days since updated
//   unpromoted_tag  target=#tag                     threshold=max days an unqualified/
//                                                   unpromoted entry may sit in PERSONAL_LOG
//   pending_rows    target=SHEET|status_col=value   threshold=max days a row may hold
//                   e.g. PROPOSALS|status=proposed  that status (created col required)
//   log_dupes       target=window minutes           threshold=allowed count (0)
// ============================================================================

function ensureHealthSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName('HEALTH');
  if (!s) {
    s = ss.insertSheet('HEALTH');
    s.appendRow(['id', 'check', 'target', 'threshold_days', 'status', 'detail', 'updated', 'notes']);
    s.getRange('A1:H1').setFontWeight('bold').setBackground('#f0f0f0');
  }
  // Seeds upsert by id: re-running setup adds newly-shipped checks to an
  // existing board without touching rows Peter has tuned.
  var seeds = [
    ['H001', 'state_stale',    'last_spanish_nudge',        2, '', '', '', 'Spanish-goal nudge heartbeat'],
    ['H002', 'state_stale',    'spendable_balance',         7, '', '', '', 'KOHO balance parser heartbeat'],
    ['H003', 'state_stale',    'rain_overnight_mm',         3, '', '', '', 'Nightly rain rollup (floyd-checkin 11pm cron)'],
    ['H004', 'state_stale',    'last_weather_pull',         2, '', '', '', 'Weather/solar pull heartbeat'],
    ['H005', 'state_stale',    'last_funnel_pull',          2, '', '', '', 'NTF funnel analytics pull heartbeat'],
    ['H006', 'unpromoted_tag', '#task',                     1, '', '', '', 'Logged tasks must land in TASKS — loop closure'],
    ['H007', 'pending_rows',   'PROPOSALS|status=proposed', 2, '', '', '', 'Evolution proposals must not rot unactioned'],
    ['H008', 'pending_rows',   'LEADS|stage=lead',         14, '', '', '', 'Leads must move stages or get flagged'],
    ['H009', 'log_dupes',      '1440',                      0, '', '', '', 'Replayed rows in last 24h — boundary dedupe watchdog'],
    ['H010', 'unpromoted_tag', '#task_done',                1, '', '', '', 'Check-in closures must reach TASKS — a stuck one means the target task was not found'],
  ];
  var haveIds = {};
  s.getDataRange().getValues().slice(1).forEach(function (r) { if (r[0]) haveIds[r[0]] = true; });
  seeds.forEach(function (r) { if (!haveIds[r[0]]) s.appendRow(r); });
  s.autoResizeColumns(1, 8);
  var rr = ss.getSheetByName('ROUTE_REGISTRY');
  if (rr) {
    var rows = rr.getDataRange().getValues();
    var haveH = rows.some(function (r) { return r[0] === 'health' && (r[1] || '').toString().toUpperCase() === 'GET'; });
    if (!haveH) rr.appendRow(['health', 'GET', 'sheet_read', '{"sheet":"HEALTH"}', 'active', 'Read self-check results']);
  }
  var cs = ss.getSheetByName('CONTEXT_SCHEMA');
  if (cs) {
    var crows = cs.getDataRange().getValues();
    var haveC = crows.some(function (r) { return r[0] === 'HEALTH'; });
    if (!haveC) cs.appendRow(['HEALTH', 'health', 'always', '{}', 25, 'Self-check results — staleness + loop-closure monitors', 'active']);
  }
  return { ok: true, sheet: 'HEALTH' };
}

// Generic evaluator — reads HEALTH rows, writes status/detail/updated in place.
// Deterministic, no model calls. OK / STALE / FAIL / SKIP (bad rule row).
function refreshHealth(ss, config) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('HEALTH');
  if (!sheet) return { skipped: 'no_sheet' };

  var now     = new Date();
  var nowIso  = now.toISOString();
  var data    = sheet.getDataRange().getValues();
  var results = { ok: 0, stale: 0, fail: 0 };

  // Shared lookups, loaded once.
  var stateByKey = {};
  var stateSheet = ss.getSheetByName('SYSTEM_STATE');
  if (stateSheet) {
    stateSheet.getDataRange().getValues().slice(1).forEach(function (r) {
      if (r[0]) stateByKey[r[0]] = { value: r[1], updated: r[6] };
    });
  }
  var birthday  = (config && config['owner_birthday']) || '1981-01-01';
  var daysAlive = Math.floor((now - new Date(birthday)) / 86400000);

  for (var i = 1; i < data.length; i++) {
    var check     = (data[i][1] || '').toString().trim();
    var target    = (data[i][2] || '').toString().trim();
    var threshold = parseFloat(data[i][3]);
    if (!check || !target || isNaN(threshold)) continue;

    var status = 'SKIP', detail = '';
    try {
      var r = evaluateHealthCheck(ss, check, target, threshold, { now: now, stateByKey: stateByKey, daysAlive: daysAlive });
      status = r.status; detail = r.detail;
    } catch (e) {
      status = 'SKIP'; detail = 'evaluator error: ' + e.message;
    }

    sheet.getRange(i + 1, 5).setValue(status);
    sheet.getRange(i + 1, 6).setValue(detail);
    sheet.getRange(i + 1, 7).setValue(nowIso);
    if (status === 'OK') results.ok++;
    else if (status === 'STALE') results.stale++;
    else if (status === 'FAIL') results.fail++;
  }
  return results;
}

function evaluateHealthCheck(ss, check, target, threshold, env) {
  var now = env.now;
  var dayMs = 86400000;

  if (check === 'state_stale') {
    var st = env.stateByKey[target];
    if (!st) return { status: 'FAIL', detail: 'key missing from SYSTEM_STATE' };
    var ts = new Date(st.updated).getTime();
    if (isNaN(ts)) return { status: 'FAIL', detail: 'no parseable updated timestamp' };
    var ageDays = (now.getTime() - ts) / dayMs;
    return ageDays > threshold
      ? { status: 'STALE', detail: 'not updated in ' + ageDays.toFixed(1) + 'd (max ' + threshold + 'd); value=' + String(st.value).substring(0, 60) }
      : { status: 'OK', detail: 'updated ' + ageDays.toFixed(1) + 'd ago' };
  }

  if (check === 'unpromoted_tag') {
    var logSheet = ss.getSheetByName('PERSONAL_LOG');
    if (!logSheet) return { status: 'SKIP', detail: 'no PERSONAL_LOG' };
    var lastRow = logSheet.getLastRow();
    if (lastRow < 2) return { status: 'OK', detail: 'log empty' };
    var n    = Math.min(500, lastRow - 1);
    var rows = logSheet.getRange(lastRow - n + 1, 1, n, 12).getValues();
    var stuck = 0;
    rows.forEach(function (r) {
      if ((r[4] || '').toString().trim() !== target) return;
      var status = (r[9] || '').toString().toLowerCase();
      if (status === 'promoted' || status === 'dormant') return;
      var ts = new Date(r[1]).getTime();
      if (isNaN(ts)) return;
      if ((now.getTime() - ts) / dayMs > threshold) stuck++;
    });
    return stuck > 0
      ? { status: 'FAIL', detail: stuck + ' ' + target + ' entr' + (stuck === 1 ? 'y' : 'ies') + ' older than ' + threshold + 'd never promoted — loop not closing' }
      : { status: 'OK', detail: 'all recent ' + target + ' entries flowing' };
  }

  if (check === 'pending_rows') {
    // target: SHEET|col=value  — rows holding that value with created/date older than threshold
    var parts = target.split('|');
    var sheetName = parts[0];
    var cond      = (parts[1] || '').split('=');
    var pSheet = ss.getSheetByName(sheetName);
    if (!pSheet) return { status: 'SKIP', detail: 'no sheet ' + sheetName };
    var pData    = pSheet.getDataRange().getValues();
    var headers  = pData[0].map(function (h) { return h.toString().toLowerCase().trim(); });
    var condCol  = headers.indexOf((cond[0] || '').toLowerCase());
    var dateCol  = headers.indexOf('created');
    if (dateCol === -1) dateCol = headers.indexOf('updated');
    if (condCol === -1 || dateCol === -1) return { status: 'SKIP', detail: 'columns not found in ' + sheetName };
    var held = 0;
    pData.slice(1).forEach(function (r) {
      if ((r[condCol] || '').toString().toLowerCase() !== (cond[1] || '').toLowerCase()) return;
      var ts = new Date(r[dateCol]).getTime();
      if (isNaN(ts)) return;
      if ((now.getTime() - ts) / dayMs > threshold) held++;
    });
    return held > 0
      ? { status: 'STALE', detail: held + ' row(s) in ' + sheetName + ' holding ' + parts[1] + ' beyond ' + threshold + 'd' }
      : { status: 'OK', detail: 'no ' + sheetName + ' rows rotting' };
  }

  if (check === 'log_dupes') {
    var lSheet = ss.getSheetByName('PERSONAL_LOG');
    if (!lSheet) return { status: 'SKIP', detail: 'no PERSONAL_LOG' };
    var lLast = lSheet.getLastRow();
    if (lLast < 3) return { status: 'OK', detail: 'log empty' };
    var ln    = Math.min(300, lLast - 1);
    var lRows = lSheet.getRange(lLast - ln + 1, 1, ln, 7).getValues();
    var windowMs = (parseFloat(target) || 1440) * 60000;
    var t = function (v) { return (v === undefined || v === null) ? '' : v.toString().trim(); };
    var seen = {}, dupes = 0;
    lRows.forEach(function (r) {
      var ts = new Date(r[1]).getTime();
      if (isNaN(ts) || (now.getTime() - ts) > windowMs) return;
      var sig = [t(r[4]), t(r[3]), t(r[5]), t(r[6])].join('|');
      if (seen[sig]) dupes++; else seen[sig] = true;
    });
    return dupes > threshold
      ? { status: 'FAIL', detail: dupes + ' replayed row(s) in window — boundary dedupe not holding' }
      : { status: 'OK', detail: 'no replays in window' };
  }

  return { status: 'SKIP', detail: 'unknown check type: ' + check };
}

// One-time (idempotent) rows that close the #task loop through EXISTING
// machinery: LOG_RULES auto_qualify so #task entries qualify on import, and a
// PROMOTION_RULES row so qualified #task entries become TASKS rows. The
// logKey 'task_item' matches the existing TASKS naming convention.
function setupLoopClosureRows(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var out = { log_rules: 'unchanged', promotion: 'unchanged', dedupe_col: 'unchanged', backlog_retired: 0 };

  var lr = ss.getSheetByName('LOG_RULES');
  if (lr) {
    var data    = lr.getDataRange().getValues();
    var headers = data[0].map(function (h) { return h.toString().toLowerCase().trim(); });
    var tagCol  = headers.indexOf('tag');
    if (tagCol === -1) tagCol = 0;
    // Registry columns the code documents but the sheet may predate — create
    // the headers so the rules can actually express them.
    var aqCol = headers.indexOf('auto_qualify');
    var nextCol = data[0].length;
    if (aqCol === -1) {
      lr.getRange(1, nextCol + 1).setValue('auto_qualify').setFontWeight('bold').setBackground('#f0f0f0');
      aqCol = nextCol; nextCol++;
      out.log_rules = 'auto_qualify column created; ';
    }
    if (headers.indexOf('dedupe_min') === -1) {
      lr.getRange(1, nextCol + 1).setValue('dedupe_min').setFontWeight('bold').setBackground('#f0f0f0');
      out.dedupe_col = 'added';
    }
    // Both loop tags auto-qualify: #task creates TASKS rows, #task_done closes
    // them (the check-in's "that's done" becomes an entry a rule acts on).
    ['#task', '#task_done'].forEach(function (tag) {
      var found = false;
      for (var i = 1; i < data.length; i++) {
        if ((data[i][tagCol] || '').toString().trim() === tag) {
          found = true;
          var cur = lr.getRange(i + 1, aqCol + 1).getValue();
          if (!(cur === true || cur === 'true')) {
            lr.getRange(i + 1, aqCol + 1).setValue(true);
            out.log_rules = (out.log_rules === 'unchanged' ? '' : out.log_rules) + 'auto_qualify enabled for ' + tag + '; ';
          }
          return;
        }
      }
      var newRow = new Array(Math.max(data[0].length, aqCol + 1)).fill('');
      newRow[tagCol] = tag; newRow[1] = 'forever'; newRow[3] = 'keep'; newRow[aqCol] = true;
      lr.appendRow(newRow);
      out.log_rules = (out.log_rules === 'unchanged' ? '' : out.log_rules) + tag + ' row added with auto_qualify; ';
    });
  }

  // PROMOTION_RULES layout in the live sheet is log_key/tag/person/active/
  // promote_to/context (runPromotionRules reads it via positional fallbacks),
  // so resolve columns by header with the same fallbacks.
  var pr = ss.getSheetByName('PROMOTION_RULES');
  if (pr) {
    var pData    = pr.getDataRange().getValues();
    var pHeaders = pData[0].map(function (h) { return h.toString().toLowerCase().trim(); });
    var col = function (names, fallbackIdx) {
      for (var n = 0; n < names.length; n++) {
        var c = pHeaders.indexOf(names[n]);
        if (c >= 0) return c;
      }
      return fallbackIdx;
    };
    var trigCol   = col(['value', 'tag'], 1);
    var activeCol = col(['status', 'active'], 3);
    var ensureRule = function (tag, logKey, verb) {
      var haveRow = -1;
      for (var j = 1; j < pData.length; j++) {
        if ((pData[j][trigCol] || '').toString().trim() === tag) { haveRow = j; break; }
      }
      if (haveRow === -1) {
        var row = new Array(pData[0].length).fill('');
        row[col(['log_key', 'key', 'id'], 0)] = logKey;
        row[trigCol] = tag;
        row[activeCol] = true;
        row[col(['promote_to', 'meta'], 4)] = verb;
        row[col(['context'], 5)] = 'anywhere';
        pr.appendRow(row);
        out.promotion = (out.promotion === 'unchanged' ? '' : out.promotion) + tag + ' → ' + verb + ' rule added; ';
      } else {
        var av = pData[haveRow][activeCol];
        if (!(av === true || av === 'TRUE' || av === 'true' || av === 'active')) {
          pr.getRange(haveRow + 1, activeCol + 1).setValue(true);
          out.promotion = (out.promotion === 'unchanged' ? '' : out.promotion) + 'existing ' + tag + ' rule was INACTIVE — activated; ';
        }
      }
    };
    ensureRule('#task', 'task_item', 'task');
    ensureRule('#task_done', 'task_close', 'task_done');
  }

  // Retire the stale backlog BEFORE the promotion loop first fires: #task
  // entries older than 7 days are abandoned intents — dormant, not tasks.
  // Without this, months of stuck entries would flood TASKS the moment the
  // rule activates. Recent entries (≤7d) qualify and promote normally.
  var logSheet = ss.getSheetByName('PERSONAL_LOG');
  if (logSheet) {
    var now  = new Date();
    var rows = logSheet.getDataRange().getValues();
    for (var k = 1; k < rows.length; k++) {
      if ((rows[k][4] || '').toString().trim() !== '#task') continue;
      var st = (rows[k][9] || '').toString().toLowerCase();
      if (st === 'promoted' || st === 'dormant') continue;
      var ts = new Date(rows[k][1]).getTime();
      if (isNaN(ts) || (now.getTime() - ts) < 7 * 86400000) continue;
      logSheet.getRange(k + 1, 10).setValue('dormant');
      out.backlog_retired++;
    }
  }
  return out;
}

// ============================================================================
// META PROCESSOR
//
// v3.4: accepts sourceRowIndex. When meta successfully writes a target,
// marks the source PERSONAL_LOG row as 'promoted' to prevent
// runPromotionRules from double-firing.
// ============================================================================

function processMeta(entry, ss, config, now, sourceRowIndex) {
  const meta = typeof entry.meta === 'string' ? safeParseJSON(entry.meta) : entry.meta;
  if (!meta || !meta.type) return;

  const handlersSheet = ss.getSheetByName('META_HANDLERS');
  let metaSucceeded = false;

  if (!handlersSheet) {
    metaSucceeded = processMetaFallback(meta, entry, ss, config, now);
  } else {
    const handlers = loadSheet(ss, 'META_HANDLERS');
    const handler  = handlers.find(h => h.meta_type === meta.type && (h.status || 'active') === 'active');

    if (!handler) {
      metaSucceeded = processMetaFallback(meta, entry, ss, config, now);
    } else {
      const hConfig = safeParseJSON(handler.config) || {};

      switch (handler.action) {
        case 'sheet_write':
          metaSucceeded = executeMetaSheetWrite(meta, entry, ss, handler, hConfig, now);
          break;
        case 'flag_row':
          metaSucceeded = executeMetaFlagRow(meta, ss, handler, hConfig);
          break;
        case 'create_sheet':
          metaSucceeded = executeMetaCreateSheet(meta, ss);
          break;
        case 'state_write':
          const stateSheet = ss.getSheetByName('SYSTEM_STATE');
          if (stateSheet && meta.target_key) {
            writeStateKey(stateSheet, meta.target_key, meta.target_value || entry.value || '', now, 'ai_import');
            metaSucceeded = true;
          }
          break;
        default:
          metaSucceeded = processMetaFallback(meta, entry, ss, config, now);
      }
    }
  }

  // v3.4: Mark source log row as promoted if meta did real work.
  // Prevents runPromotionRules from re-firing this entry.
  if (metaSucceeded && sourceRowIndex) {
    const logSheet = ss.getSheetByName('PERSONAL_LOG');
    if (logSheet) {
      try {
        logSheet.getRange(sourceRowIndex, 10).setValue('promoted');
      } catch (e) {
        // Row may have been deleted or moved — not fatal
      }
    }
  }
}

function executeMetaSheetWrite(meta, entry, ss, handler, hConfig, now) {
  if (!meta.target_sheet || !meta.target_key) return false;
  const targetSheet = ss.getSheetByName(meta.target_sheet);
  if (!targetSheet) return false;

  const keyCol = (meta.key_column || (hConfig && hConfig.key_column) || 1) - 1;
  const data   = targetSheet.getDataRange().getValues();
  const keyLow = meta.target_key.toString().toLowerCase();
  let found    = false;

  for (let j = 0; j < data.length; j++) {
    if (data[j][keyCol] && data[j][keyCol].toString().toLowerCase() === keyLow) {
      found = true;
      if (meta.target_values) {
        for (const [col, val] of Object.entries(meta.target_values)) {
          const c = parseInt(col);
          if (!isNaN(c)) targetSheet.getRange(j + 1, c).setValue(val);
        }
      } else {
        targetSheet.getRange(j + 1, meta.target_column || 2).setValue(entry.value || entry.notes);
      }
      break;
    }
  }

  if (!found) {
    const lastCol = Math.max(targetSheet.getLastColumn(), 2);
    const newRow  = new Array(lastCol).fill('');
    newRow[keyCol] = meta.target_key;
    if (meta.target_values) {
      for (const [col, val] of Object.entries(meta.target_values)) newRow[parseInt(col) - 1] = val;
    } else {
      newRow[(meta.target_column || 2) - 1] = entry.value || entry.notes;
    }
    targetSheet.appendRow(newRow);
  }

  return true;
}

function executeMetaFlagRow(meta, ss, handler, hConfig) {
  if (!meta.entry_id) return false;
  const targetSheet = ss.getSheetByName(handler.target || 'PERSONAL_LOG');
  if (!targetSheet) return false;
  const idCol   = parseInt(hConfig.id_column || 3) - 1;
  const flagCol = parseInt(hConfig.flag_column || 12);
  const data    = targetSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] && data[i][idCol].toString() === meta.entry_id) {
      targetSheet.getRange(i + 1, flagCol).setValue(meta.flag_value || 'true');
      if (meta.new_tag) targetSheet.getRange(i + 1, 5).setValue(meta.new_tag);
      return true;
    }
  }
  return false;
}

function executeMetaCreateSheet(meta, ss) {
  if (!meta.sheet_name || ss.getSheetByName(meta.sheet_name)) return false;
  const newSheet = ss.insertSheet(meta.sheet_name);
  if (meta.headers) {
    newSheet.appendRow(meta.headers);
    newSheet.getRange('1:1').setFontWeight('bold').setBackground('#f0f0f0');
  }
  return true;
}

function processMetaFallback(meta, entry, ss, config, now) {
  const stateSheet = ss.getSheetByName('SYSTEM_STATE');
  let succeeded = false;

  if (meta.type === 'promotion' && meta.target_sheet && meta.target_key) {
    succeeded = executeMetaSheetWrite(meta, entry, ss, null, {}, now);
  }
  if (meta.type === 'schema_update' && meta.action === 'create_sheet') {
    succeeded = executeMetaCreateSheet(meta, ss) || succeeded;
  }
  if (meta.type === 'qualify' && meta.entry_id) {
    const logSheet = ss.getSheetByName('PERSONAL_LOG');
    if (logSheet) {
      const data = logSheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (data[i][2] && data[i][2].toString() === meta.entry_id) {
          logSheet.getRange(i + 1, 12).setValue('true');
          if (meta.new_tag) logSheet.getRange(i + 1, 5).setValue(meta.new_tag);
          succeeded = true;
          break;
        }
      }
    }
  }
  if (meta.type === 'state_update' && meta.target_key && stateSheet) {
    writeStateKey(stateSheet, meta.target_key, meta.target_value || entry.value || '', now, 'ai_import');
    succeeded = true;
  }

  return succeeded;
}

// ============================================================================
// NOTIFICATION HANDLER
// ============================================================================

// Returns true if a notification's fields are unresolved sender-side template
// placeholders that must never be logged — pure noise. Covers two forms:
//   - Tasker AutoNotification vars left un-substituted: %antitle, %antext, %anapp
//   - Literal descriptive tokens wrapping the whole field: "<notification title>",
//     "<app package name>" (a broken HTTP-request body template on the phone).
// Checks each passed field; a field counts as a placeholder only if the ENTIRE
// trimmed value is a "<...>" token, so real text containing "<3" isn't dropped.
function isUnresolvedNotification() {
  for (var i = 0; i < arguments.length; i++) {
    var s = (arguments[i] || '').toString();
    if (!s) continue;
    if (s.indexOf('%an') !== -1) return true;
    if (/^<[^>]+>$/.test(s.trim())) return true;
  }
  return false;
}

function handleNotification(params, ss, config) {
  const ownerId    = config['owner_id']       || 'owner';
  const ownerBday  = config['owner_birthday'] || '1981-01-01';
  const notifData  = params.notification ? params : {
    package: params.package, notification: params.notification, device_state: params.device_state || {}
  };

  const excluded = (config['excluded_notification_packages'] || '').split(',').map(s => s.trim());
  const pkg      = notifData.package;

  if (excluded.includes(pkg)) return { status: 'skipped', reason: 'excluded_package' };

  const notification = notifData.notification || {};
  const now          = new Date();
  const daysAlive    = Math.floor((now - new Date(ownerBday)) / 86400000);

  if (notification.title && notification.title.includes('%antitle')) notification.title = 'Notification';
  if (notification.text  && notification.text.includes('%antext'))   notification.text  = '';

  // Drop fully-unresolved placeholder notifications (broken sender template)
  // before they reach the log or the stats sheet.
  if (isUnresolvedNotification(notification.title, notification.text, pkg)) {
    return { status: 'skipped', reason: 'unresolved_placeholder' };
  }

  const id = 'N' + now.getTime() + '_' + Math.random().toString(36).substr(2, 5);

  parseNotificationWithRules(ss, pkg, notification, now, config);

  ss.getSheetByName('PERSONAL_LOG').appendRow([
    daysAlive, now.toISOString(), id, ownerId, '#notification',
    '[' + friendlyAppName(ss, pkg) + '] ' + (notification.title || 'Notification'),
    JSON.stringify({
      package: pkg, title: notification.title,
      text: notification.text ? notification.text.substring(0, 500) : '',
      posted: notification.posted
    }),
    '', 'tasker', 'active', 1, 'true'
  ]);

  applyLogRules(ss, '#notification');
  updateNotificationStats(ss, pkg, notification);
  return { status: 'success', id };
}

function friendlyAppName(ss, packageName) {
  if (!packageName) return '';
  const sheet = ss.getSheetByName('APP_NAMES');
  if (!sheet) return packageName;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString() === packageName) {
      return (data[i][1] || packageName).toString();
    }
  }
  return packageName;
}

// ============================================================================
// CHECKIN PREP — lean surface, counts only, no full arrays
//
// v3.4: adds validation_errors count for growth feedback surface
// ============================================================================

function buildCheckinPrep(params, ss, config) {
  const ownerBday  = config['owner_birthday'] || '1981-01-01';
  const ownerId    = config['owner_id']       || 'owner';
  const now        = new Date();
  const todayDa    = Math.floor((now - new Date(ownerBday)) / 86400000);
  const cutoff30   = todayDa - 30;

  ageDormantEntries(ss, cutoff30);

  const stateSheet = ss.getSheetByName('SYSTEM_STATE');
  const fullState  = {};
  const staleState = {};
  const staleKeys  = [
    'current_location','spendable_balance','van_status',
    'active_project','notes','voice_note','spent_today','last_merchant'
  ];

  if (stateSheet) {
    stateSheet.getDataRange().getValues().slice(1).forEach(r => {
      if (!r[0]) return;
      fullState[r[0].toString()] = r[1] ? r[1].toString() : '';
    });
  }

  staleKeys.forEach(key => {
    const val = fullState[key] || '';
    const isEmpty = !val || val.startsWith('qualified entry');
    if (isEmpty) staleState[key] = val;
  });

  const partnerSheet = ss.getSheetByName('PARTNER_STATE');
  const partner      = {};
  if (partnerSheet) {
    partnerSheet.getDataRange().getValues().slice(1).forEach(r => {
      if (r[1]) partner[r[1].toString()] = r[2] ? r[2].toString() : '';
    });
  }

  const locInfo        = determineMode(fullState['current_location'] || '', config);
  const currentContext = resolveTaskContext(locInfo.mode, config);

  const logSheet = ss.getSheetByName('PERSONAL_LOG');
  const logData  = logSheet ? logSheet.getDataRange().getValues().slice(1).filter(r => r[0]) : [];

  let unqualCount  = 0;
  let dormantCount = 0;
  const todayTags  = new Set();

  logData.forEach(r => {
    const da        = parseInt(r[0]);
    const tag       = (r[4] || '').toString();
    const qualified = (r[11] || '').toString().toLowerCase();
    const status    = (r[9]  || '').toString().toLowerCase();

    if (tag === '#unresolved')  { dormantCount++; return; }
    if (status === 'promoted')  return;
    if (qualified === 'false' && da >= cutoff30) { unqualCount++; return; }
    if (da === todayDa) todayTags.add(tag);
  });

  // v3.4: count unresolved validation errors for growth surface
  let validationErrorCount = 0;
  const vlSheet = ss.getSheetByName('VALIDATION_LOG');
  if (vlSheet) {
    const vlData = vlSheet.getDataRange().getValues().slice(1);
    validationErrorCount = vlData.filter(r => {
      if (!r[VL_COL_TIMESTAMP - 1]) return false;
      const resolved = (r[VL_COL_RESOLVED - 1] || '').toString().toLowerCase();
      return resolved !== 'true';
    }).length;
  }

  const tasksSheet     = ss.getSheetByName('TASKS');
  let contextTaskCount = 0;
  const topTasks       = [];

  if (tasksSheet) {
    const taskData    = tasksSheet.getDataRange().getValues();
    const taskHeaders = taskData[0].map(h => h.toString().toLowerCase().trim());
    const statusCol   = taskHeaders.indexOf('status');
    const contextCol  = taskHeaders.indexOf('context');
    const keyCol      = taskHeaders.indexOf('key');
    const metaCol     = taskHeaders.indexOf('meta');
    const idCol       = taskHeaders.indexOf('id');

    // FIX 2: collect all matching tasks first, then sort and splice to top 3
    taskData.slice(1).filter(r => {
      if (!r[idCol || 0]) return false;
      const s = statusCol >= 0 ? r[statusCol].toString() : '';
      return s === 'open';
    }).forEach(r => {
      const ctx = contextCol >= 0 ? (r[contextCol] || 'anywhere').toString().toLowerCase() : 'anywhere';
      if (ctx === 'anywhere' || ctx === currentContext) {
        contextTaskCount++;
        const meta     = metaCol >= 0 ? r[metaCol].toString() : '';
        const priority = (meta.match(/priority:(\d+)/) || [])[1] || '99';
        topTasks.push({
          id:       r[idCol || 0],
          key:      keyCol >= 0 ? r[keyCol] : '',
          priority: parseInt(priority),
          context:  ctx
        });
      }
    });
    topTasks.sort((a, b) => a.priority - b.priority);
    topTasks.splice(3);
  }

  const urgentAlerts = buildCalendarAlerts(ss, todayDa).filter(a => a.days_until <= 3);

  const sessSheet = ss.getSheetByName('AI_SESSIONS');
  let lastSession = null;
  if (sessSheet) {
    const rows = sessSheet.getDataRange().getValues().slice(1).filter(r => r[0]);
    if (rows.length > 0) {
      const last = rows[rows.length - 1];
      lastSession = { timestamp: last[1], summary: last[4] };
    }
  }

  // FIX 3: include task_id_counter in return object
  return {
    _type: 'checkin_prep',
    task_id_counter: fullState['TASK_ID_COUNTER'] || 'T001',
    _meta: {
      generated:       now.toISOString(),
      days_alive:      todayDa,
      owner_name:      config['owner_name'] || '',
      owner_id:        ownerId,
      current_context: currentContext,
      location_city:   locInfo.city,
      version:         '3.4'
    },
    stale_state:   staleState,
    partner:       { phase: partner['current_phase'] || '', days_until_next: partner['days_until_next'] || '' },
    urgent_alerts: urgentAlerts,
    top_tasks:     topTasks,
    last_session:  lastSession,
    counts: {
      unqualified:       unqualCount,
      dormant:           dormantCount,
      validation_errors: validationErrorCount,
      context_tasks:     contextTaskCount,
      tags_today:        Array.from(todayTags),
      current_context:   currentContext
    }
  };
}

function resolveTaskContext(systemMode, config) {
  const homeMode   = config['home_mode']         || 'home';
  const secondMode = config['second_space_mode'] || 'second';
  if (systemMode === homeMode)   return (config['home_task_context']         || 'tuliptown').toLowerCase();
  if (systemMode === secondMode) return (config['second_space_task_context'] || 'van').toLowerCase();
  return 'anywhere';
}

// ============================================================================
// CALENDAR
// ============================================================================

function buildCalendarAlerts(ss, todayDa) {
  const sheet = ss.getSheetByName('CALENDAR');
  if (!sheet) return [];

  const ownerBday = loadConfig(ss)['owner_birthday'] || '1981-01-01';
  const now       = new Date();
  const alerts    = [];

  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().toLowerCase().trim());

  const keyCol    = headers.indexOf('key');
  const valueCol  = headers.indexOf('value');
  const statusCol = headers.indexOf('status');
  const notesCol  = headers.indexOf('notes');
  const metaCol   = headers.indexOf('meta');

  const getKey    = (r) => keyCol >= 0    ? r[keyCol]    : r[0];
  const getValue  = (r) => valueCol >= 0  ? r[valueCol]  : r[1];
  const getStatus = (r) => statusCol >= 0 ? r[statusCol] : r[3];
  const getNotes  = (r) => notesCol >= 0  ? r[notesCol]  : r[4];
  const getMeta   = (r) => {
    const raw = metaCol >= 0 ? r[metaCol] : r[2];
    return safeParseJSON(raw) || {};
  };

  data.slice(1).forEach(row => {
    const key    = (getKey(row)    || '').toString().trim();
    const value  = (getValue(row)  || '').toString().trim();
    const status = (getStatus(row) || 'active').toString().trim();

    if (!key || !value || status !== 'active') return;

    let eventDate;
    try { eventDate = new Date(value); } catch(e) { return; }
    if (isNaN(eventDate.getTime())) return;

    const cfg          = getMeta(row);
    const eventDa      = Math.floor((eventDate - new Date(ownerBday)) / 86400000);
    const daysUntil    = eventDa - todayDa;
    const notifyBefore = parseInt(cfg.notify_days_before || 7);

    if (daysUntil >= 0 && daysUntil <= notifyBefore) {
      alerts.push({
        key,
        date:       value,
        days_until: daysUntil,
        tag:        cfg.tag || '#calendar',
        notes:      getNotes(row) || '',
        urgent:     daysUntil <= 2
      });
    }
  });

  alerts.sort((a, b) => a.days_until - b.days_until);
  return alerts;
}

// ============================================================================
// GOOGLE CALENDAR SYNC  (T017)
//
// The web app runs as the deploying Google account (USER_DEPLOYING), so the
// built-in CalendarApp can read that account's calendars with no OAuth client,
// no n8n, no extra Worker. Pulls upcoming events into the CALENDAR sheet:
//   • the default calendar  → #calendar rows  (feeds Appointments card + alerts)
//   • an optional shared calendar named CONFIG.partner_calendar → #partner_travel
//     rows (drives partner presence / "Esther is in Regina").
// Idempotent: every gcal event upserts by a stable key, so re-runs never dupe.
// One-time setup: the owner runs setupCalendarSync() once in the Apps Script
// editor to grant the Calendar + trigger scopes; after that the 6-hour trigger
// and the ?type=sync_calendar route both work.
// ============================================================================

function syncGoogleCalendar(ss, config, params) {
  const days = parseInt((params && params.days) || config['calendar_sync_days'] || 45);
  const now  = new Date();
  const until = new Date(now.getTime() + days * 86400000);
  const tz   = config['timezone'] || 'America/Toronto';

  let calSheet = ss.getSheetByName('CALENDAR');
  if (!calSheet) {
    calSheet = ss.insertSheet('CALENDAR');
    calSheet.appendRow(['id', 'key', 'value', 'status', 'context', 'notes', 'meta', 'updated']);
  }

  const data     = calSheet.getDataRange().getValues();
  const keyToRow = {};
  for (let i = 1; i < data.length; i++) { if (data[i][1]) keyToRow[data[i][1].toString()] = i + 1; }

  const dateOnly = (d) => Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  function upsert(key, value, notes, meta) {
    const metaStr = JSON.stringify(meta);
    const row = keyToRow[key];
    if (row) {
      calSheet.getRange(row, 3).setValue(value);
      calSheet.getRange(row, 4).setValue('active');
      calSheet.getRange(row, 6).setValue(notes);
      calSheet.getRange(row, 7).setValue(metaStr);
      calSheet.getRange(row, 8).setValue(now.toISOString());
    } else {
      calSheet.appendRow([key, key, value, 'active', 'anywhere', notes, metaStr, now.toISOString()]);
      keyToRow[key] = calSheet.getLastRow();
    }
  }
  const safeId = (ev, pfx) => pfx + ev.getId().replace(/[^a-zA-Z0-9_]/g, '').slice(0, 44);

  let appts = 0, travel = 0;

  // 1) Default calendar → general appointments
  const def = CalendarApp.getDefaultCalendar();
  if (def) {
    def.getEvents(now, until).forEach(ev => {
      const evKey = safeId(ev, 'gcal_');
      const isNew = !keyToRow[evKey];
      upsert(
        evKey,
        dateOnly(ev.getStartTime()),
        ev.getTitle() || 'event',
        { tag: '#calendar', source: 'gcal', gcal_id: ev.getId(),
          notify_days_before: 7, location: ev.getLocation() || '', all_day: ev.isAllDayEvent() }
      );
      appts++;
      // notthefinger funnel: a NEW event whose title smells like a booked call
      // (Calendly writes "<event type> between/and <invitee>") becomes a LEADS
      // row + a phone push. Never let funnel plumbing break the sync itself.
      if (isNew && /consult|discovery|notthefinger|calendly/i.test(ev.getTitle() || '')) {
        try { registerBooking(ev, ss, config, now, dateOnly); } catch (err) {
          Logger.log('registerBooking failed: ' + err.message);
        }
      }
    });
  }

  // 2) Optional shared calendar → partner travel / whereabouts
  const pcName = (config['partner_calendar'] || '').toString().trim();
  if (pcName) {
    const cals = resolveCalendars(pcName);
    if (cals && cals.length) {
      // Look back too, so the most-recently-landed flight is captured (it sets
      // her current location even though it's in the past).
      const pStart = new Date(now.getTime() - 14 * 86400000);
      cals[0].getEvents(pStart, until).forEach(ev => {
        const title = (ev.getTitle() || '').trim();
        // Flight leg: "754: YQR-YYZ(0600-1100)" → departs YQR, arrives YYZ.
        const fm = title.match(/^(\d{2,4})\s*:\s*([A-Z]{3})\s*-\s*([A-Z]{3})/);
        if (fm && !ev.isAllDayEvent()) {
          upsert(
            safeId(ev, 'gcalf_'),
            dateOnly(ev.getEndTime()),
            title,
            { tag: '#partner_flight', source: 'gcal', gcal_id: ev.getId(), flight: fm[1],
              dep: fm[2], arr: fm[3],
              dep_iso: ev.getStartTime().toISOString(), arr_iso: ev.getEndTime().toISOString() }
          );
          travel++;
          return;
        }
        // Non-flight fallback: a MULTI-DAY all-day block = generic whereabouts.
        if (ev.isAllDayEvent()) {
          const startD = ev.getAllDayStartDate(), endExcl = ev.getAllDayEndDate();
          if (Math.round((endExcl - startD) / 86400000) < 2) return;
          const endD = new Date(endExcl.getTime() - 86400000);
          upsert(
            safeId(ev, 'gcalp_'),
            dateOnly(endD),
            (config['partner_name'] || 'Partner') + ': ' + title,
            { tag: '#partner_travel', source: 'gcal', gcal_id: ev.getId(),
              location: title, start: dateOnly(startD) }
          );
          travel++;
        }
      });
    }
  }

  writeStateKey(ss.getSheetByName('SYSTEM_STATE'), 'last_calendar_sync', now.toISOString(), now, 'gcal_sync');
  return { status: 'success', appointments: appts, partner_events: travel, window_days: days,
           partner_calendar: pcName || '(not configured)' };
}

// ============================================================================
// NOTTHEFINGER BOOKING → LEAD  (funnel CAPTURE half)
//
// Fires from syncGoogleCalendar when a brand-new default-calendar event looks
// like a booked Discovery/consultation call. Writes a LEADS row (stage=booked),
// logs a #lead entry, pushes a Join notification via floyd-checkin (same
// pattern as maybeCreateAlarmFromNote), and stamps ntf_last_booking. LEADS is
// created on first use by handleSheetWrite; context exposes it via the
// CONTEXT_SCHEMA 'leads' row, so the nightly brief sees the pipeline.
// ============================================================================
function registerBooking(ev, ss, config, now, dateOnly) {
  const title = (ev.getTitle() || '').trim();
  const when  = dateOnly(ev.getStartTime());
  // Invitee guess: strip the event-type words and Peter's own name; what's
  // left is usually the client. Falls back to the raw title.
  const name = title
    .replace(/consultation|consult|discovery|call|meeting|notthefinger|calendly|between|and|with/gi, ' ')
    .replace(new RegExp((config['owner_name'] || 'Peter Aitchison'), 'gi'), ' ')
    .replace(/\s+/g, ' ').trim() || title;
  const leadId = 'L' + ev.getId().replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24);

  handleSheetWrite({
    sheet: 'LEADS', ai: 'gcal_sync',
    headers: ['id', 'created', 'name', 'source', 'stage', 'offer', 'value_cad',
              'next_action', 'next_date', 'notes', 'updated'],
    rows: [{ match_column: 1, match_value: leadId, values: {
      '1': leadId, '2': now.toISOString(), '3': name, '4': 'calendly', '5': 'booked',
      '6': 'discovery', '7': '150', '8': 'prep the call — read their stuck thing',
      '9': when, '10': title, '11': now.toISOString()
    } }]
  }, ss, config, {});

  handleImport({ ai: 'gcal_sync', entries: [{
    tag: '#lead', value: 'Discovery booked: ' + name + ' — ' + when, notes: title
  }] }, ss, config, {});

  const base  = (config['checkin_url'] || 'https://floyd-checkin.aitchisonpeter.workers.dev/').replace(/\/+$/, '/');
  const token = getApiSecret(config) || '';
  UrlFetchApp.fetch(base + '?key=' + encodeURIComponent(token)
    + '&type=notify&title=' + encodeURIComponent('🌕 Discovery booked')
    + '&text=' + encodeURIComponent(name + ' · ' + when), { muteHttpExceptions: true });

  writeStateKey(ss.getSheetByName('SYSTEM_STATE'), 'ntf_last_booking',
                when + ' · ' + name, now, 'ntf_funnel');
  return { lead: leadId, name: name, date: when };
}

// Resolve a calendar spec that may be either a Google calendar ID (contains '@')
// or a display name. ID is preferred — robust to renames/duplicate names.
function resolveCalendars(spec) {
  if (!spec) return [];
  if (spec.indexOf('@') >= 0) { const c = CalendarApp.getCalendarById(spec); return c ? [c] : []; }
  return CalendarApp.getCalendarsByName(spec) || [];
}

// IATA → city for partner-flight display. Covers her routes + common hubs;
// unknown codes fall back to the raw code. (Move to a sheet if it grows.)
const AIRPORTS = {
  YYZ: 'Toronto', YQR: 'Regina', YYC: 'Calgary', YOW: 'Ottawa', YUL: 'Montreal',
  YVR: 'Vancouver', YWG: 'Winnipeg', YEG: 'Edmonton', YHZ: 'Halifax', YYT: "St. John's",
  YQB: 'Quebec City', YXE: 'Saskatoon', YQM: 'Moncton', YYJ: 'Victoria', YLW: 'Kelowna',
  DEN: 'Denver', FLL: 'Fort Lauderdale', LAX: 'Los Angeles', JFK: 'New York', LGA: 'New York',
  EWR: 'Newark', ORD: 'Chicago', SFO: 'San Francisco', LAS: 'Las Vegas', MCO: 'Orlando',
  YYJ_: 'Victoria', BOS: 'Boston', SEA: 'Seattle', PHX: 'Phoenix', MIA: 'Miami'
};
function airportCity(code) {
  const c = (code || '').toString().toUpperCase();
  return AIRPORTS[c] || c;
}

function scheduledCalendarSync() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return syncGoogleCalendar(ss, loadConfig(ss), {});
}

// ============================================================================
// PARTNER PRESENCE  (alone vs together — a first-class surfacing variable)
//
// Derives whether the partner is home (together) or away (alone) and, when away,
// where + when she's back. Flight-crew model first (#partner_flight legs), then a
// multi-day all-day #partner_travel fallback. Returns a posture both the brief and
// the check-in factor in: together → "do less, protect the time"; alone → "lean
// in, deep-work window". Read-only (no writes) so it's safe on any route.
// ============================================================================
function computePartnerPresence(ss, config) {
  const home = (config['partner_home_airport'] || 'YYZ').toString().toUpperCase();
  const partner = config['partner_name'] || 'Esther';
  const homeResult = (extra) => Object.assign({
    status: 'home', present: true, location: null, away_until: null,
    posture: 'protect_together', cap: 1,
    note: partner + " is home — do less, protect the time"
  }, extra || {});
  const awayResult = (location, away_until) => ({
    status: 'working', present: false, location: location, away_until: away_until,
    posture: 'solo_focus', cap: 3,
    note: 'Solo until ' + (away_until || (partner + " is back")) + ' — deep-work window, lean in'
  });

  const calSheet = ss.getSheetByName('CALENDAR');
  if (!calSheet) return homeResult();
  const cd = calSheet.getDataRange().getValues();
  if (cd.length < 2) return homeResult();
  const H  = cd[0].map(h => h.toString().toLowerCase().trim());
  const ci = (name) => H.indexOf(name);
  const mi = H.indexOf('meta');
  const nowT = new Date();

  // Flight-crew model
  const flights = [];
  cd.slice(1).forEach(r => {
    const meta = safeParseJSON(r[mi]) || {};
    if ((meta.tag || '') === '#partner_flight' && meta.dep && meta.arr) {
      flights.push({ dep: String(meta.dep).toUpperCase(), arr: String(meta.arr).toUpperCase(),
                     depT: new Date(meta.dep_iso), arrT: new Date(meta.arr_iso) });
    }
  });
  if (flights.length) {
    flights.sort((a, b) => a.depT - b.depT);
    let current = null, lastArr = null;
    flights.forEach(f => { if (f.arrT <= nowT && (!lastArr || f.arrT > lastArr)) { lastArr = f.arrT; current = f.arr; } });
    if (!current) { const nxt = flights.filter(f => f.depT > nowT)[0]; current = nxt ? nxt.dep : home; }
    if (current === home) return homeResult();
    const back = flights.filter(f => f.arr === home && f.arrT > nowT).sort((a, b) => a.arrT - b.arrT)[0];
    let until = 'return TBD';
    if (back) {
      const dleft = Math.ceil((back.arrT - nowT) / 86400000);
      until = Utilities.formatDate(back.arrT, 'America/Toronto', 'EEE MMM d, h:mm a') + ' (' + (dleft <= 0 ? 'today' : dleft + 'd') + ')';
    }
    return awayResult(airportCity(current), until);
  }

  // Fallback: multi-day all-day #partner_travel block
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let away = null;
  cd.slice(1).forEach(r => {
    const meta = safeParseJSON(r[mi]) || {};
    if ((meta.tag || '').toString() !== '#partner_travel') return;
    if ((r[ci('status')] || 'active').toString().trim() !== 'active') return;
    const start = meta.start ? new Date(meta.start) : null;
    const endRaw = r[ci('value')];
    const end   = endRaw ? new Date(endRaw) : null;
    const startsOk = (!start || isNaN(start)) ? true : start <= today;
    const endsOk   = (!end   || isNaN(end))   ? true : today <= end;
    if (startsOk && endsOk) away = { location: meta.location || (r[ci('notes')] || '').toString(), end: (end && !isNaN(end)) ? end : null };
  });
  if (!away) return homeResult();
  let until = 'return TBD';
  if (away.end) {
    const daysBack = Math.ceil((away.end - today) / 86400000);
    until = Utilities.formatDate(away.end, 'America/Toronto', 'EEE MMM d') + ' (' + (daysBack <= 0 ? 'today' : daysBack + 'd') + ')';
  }
  return awayResult(away.location || '(away)', until);
}

// Mirror partner presence into SYSTEM_STATE (guarded on-change) so EVERY reader —
// MCP context, nightly brief, conversational check-in — always has it, not just
// the dashboard. Same pattern as syncPartnerCycleToState.
function syncPresenceToState(ss, p) {
  if (!p) return;
  const stateSheet = ss.getSheetByName('SYSTEM_STATE');
  if (!stateSheet) return;
  const want = {
    partner_status:   p.status,
    partner_present:  p.present ? 'yes' : 'no',
    presence_posture: p.posture,
    presence_note:    p.note
  };
  if (p.location)   want.partner_location  = p.location;
  if (p.away_until) want.partner_away_until = p.away_until;
  const cur = {};
  stateSheet.getDataRange().getValues().slice(1).forEach(r => { cur[r[0]] = r[1]; });
  const now = new Date();
  Object.keys(want).forEach(k => {
    if (want[k] === '' || want[k] == null) return;
    if (String(cur[k]) !== String(want[k])) writeStateKey(stateSheet, k, want[k], now, 'presence_compute');
  });
}

function installCalendarTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'scheduledCalendarSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scheduledCalendarSync').timeBased().everyHours(6).create();
  return { status: 'success', trigger: 'scheduledCalendarSync every 6h' };
}

// Owner runs this ONCE in the Apps Script editor: grants Calendar + trigger
// scopes, installs the 6-hour trigger, and does the first sync.
function setupCalendarSync() {
  const trig = installCalendarTrigger();
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const sync = syncGoogleCalendar(ss, loadConfig(ss), {});
  return { trigger: trig, first_sync: sync };
}

// ============================================================================
// GMAIL HYGIENE  (T024)
//
// GmailApp runs as USER_DEPLOYING (same as CalendarApp), so these read/triage
// the deploying account's mailbox with no OAuth client. Companions to the
// calendar sync — they let Floyd (and Claude over the token API) survey senders,
// trash confirmed noise, and install filters so the noise never returns. The
// Phase-2 ingestion Worker reads peek_gmail to extract tasks/appointments/bills.
//
// One-time setup: the owner runs setupGmailAccess() once in the editor to grant
// the Gmail scopes (GmailApp + the Gmail advanced service used for filters).
// ============================================================================

// Pull "Name <email>" → bare lowercased address (falls back to the raw string).
function gmailAddr(from) {
  var m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).toLowerCase().trim();
}

// Parse a To/Cc header (comma-separated, mixed "Name <a@x>" / bare) into a
// deduped list of lowercased addresses. Used for outbound (in:sent) scans where
// the meaningful party is the recipient(s), not the From (always Peter).
function gmailAddrList(header) {
  var seen = {}, out = [];
  String(header || '').split(',').forEach(function (part) {
    var a = gmailAddr(part);
    if (a && a.indexOf('@') > 0 && !seen[a]) { seen[a] = 1; out.push(a); }
  });
  return out;
}

// Read-only inbox peek. params: q (gmail query, default in:inbox), max (≤100).
// This is the door the Phase-2 ingestion Worker reads.
function peekGmail(params) {
  var q   = (params.q || 'in:inbox').toString();
  var max = Math.min(parseInt(params.max) || 25, 100);
  var threads = GmailApp.search(q, 0, max);
  return { query: q, count: threads.length, threads: threads.map(function (t) {
    var msgs = t.getMessages(), m = msgs[msgs.length - 1]; // most recent message
    return {
      thread_id: t.getId(),
      from:      m.getFrom(),
      address:   gmailAddr(m.getFrom()),
      subject:   t.getFirstMessageSubject(),
      date:      m.getDate().toISOString(),
      unread:    t.isUnread(),
      messages:  t.getMessageCount(),
      snippet:   String(m.getPlainBody() || '').replace(/\s+/g, ' ').slice(0, 200)
    };
  }) };
}

// Read-only sender histogram for building the triage / unsubscribe hit-list.
// params: q (default in:inbox), scan (threads to walk, ≤500), top (rows back).
function gmailSenderStats(params) {
  var q    = (params.q || 'in:inbox').toString();
  var scan = Math.min(parseInt(params.scan) || 200, 500);
  // Outbound scans count the RECIPIENT(s) — on in:sent the From is always Peter,
  // so the correspondent is whoever he wrote to. Auto-detected from the query,
  // or forced with field=recipient. (T037: outbound email counts into PEOPLE.)
  var byRecipient = (params.field || '').toString() === 'recipient' || /\bin:sent\b/.test(q);
  var counts = {}, latest = {}, off = 0;
  while (off < scan) {
    var batch = GmailApp.search(q, off, Math.min(100, scan - off));
    if (!batch.length) break;
    batch.forEach(function (t) {
      var m = t.getMessages()[0];
      var d = m.getDate().toISOString();
      var addrs = byRecipient ? gmailAddrList(m.getTo()) : [gmailAddr(m.getFrom())];
      addrs.forEach(function (a) {
        if (!a) return;
        counts[a] = (counts[a] || 0) + 1;
        if (!latest[a] || d > latest[a]) latest[a] = d;
      });
    });
    off += batch.length;
    if (batch.length < 100) break;
  }
  var rows = Object.keys(counts)
    .map(function (a) { return { sender: a, count: counts[a], latest: latest[a] }; })
    .sort(function (x, y) { return y.count - x.count; });
  return { scanned: off, unique_senders: rows.length, direction: byRecipient ? 'sent' : 'received',
           top: rows.slice(0, parseInt(params.top) || 40) };
}

// ============================================================================
// CORRESPONDENCE CAPTURE (T040) — the relationship RECORD, not the headcount
//
// For every PEOPLE row with a resolvable email, pull recent Gmail threads in
// BOTH directions into a CORRESPONDENCE tab — both halves of the conversation,
// captured at source, so the relationship is a queryable timeline years from
// now, not just a live-summary that gets overwritten.
//
// PRIVACY (Peter's rule): CORRESPONDENCE inherits PERSONAL_LOG-level care — it
// is written by a token-gated route, read only by a token-gated route, and
// NEVER rides in a context packet that leaves for a third-party engine unless
// Peter explicitly selects it. There is no open surface onto it.
//
// Dedup key = person_id|thread_id|message-date, so nightly re-runs only append
// genuinely new messages. params: days (window, ≤90, default 14),
// per_person (threads/person cap, ≤50, default 15), dry (1 = resolve + count,
// write nothing).
// ============================================================================
function captureCorrespondence(ss, config, params) {
  var days       = Math.min(parseInt(params.days) || 14, 90);
  var perCap     = Math.min(parseInt(params.per_person) || 15, 50);
  var ownerEmail = (config['owner_email'] || '').toString().toLowerCase().trim();
  var dry        = (params.dry || '').toString() === '1';

  var targets = resolvePeopleEmails(ss);
  if (dry) return { status: 'success', dry_run: true, owner_email: ownerEmail,
                    targets: targets.slice(0, 60), resolvable: targets.length };

  var corr = ensureCorrespondenceSheet(ss);
  var existing = {};
  var cdata = corr.getDataRange().getValues();
  for (var i = 1; i < cdata.length; i++) {
    existing[cdata[i][0] + '|' + cdata[i][6] + '|' + cdata[i][1]] = true; // person|thread|date
  }

  var added = 0, scanned = 0, out = [];
  targets.slice(0, 60).forEach(function (t) {
    if (!t.email) return;
    scanned++;
    var q = 'newer_than:' + days + 'd (from:' + t.email + ' OR to:' + t.email + ')';
    var threads;
    try { threads = GmailApp.search(q, 0, perCap); } catch (e) { return; }
    threads.forEach(function (th) {
      var tid = th.getId();
      var subject = th.getFirstMessageSubject() || '';
      th.getMessages().forEach(function (m) {
        var date = m.getDate().toISOString();
        var k    = t.person_id + '|' + tid + '|' + date;
        if (existing[k]) return;
        existing[k] = true;
        var fromAddr  = gmailAddr(m.getFrom());
        var direction = (ownerEmail && fromAddr === ownerEmail) ? 'out' : 'in';
        var excerpt   = String(m.getPlainBody() || '').replace(/\s+/g, ' ').slice(0, 1000);
        out.push([t.person_id, date, 'email', direction, subject, excerpt, tid, new Date().toISOString()]);
        added++;
      });
    });
  });
  if (out.length) corr.getRange(corr.getLastRow() + 1, 1, out.length, out[0].length).setValues(out);
  writeStateKey(ss.getSheetByName('SYSTEM_STATE'), 'last_correspondence_pull',
                new Date().toISOString(), new Date(), 'correspondence');
  return { status: 'success', people_scanned: scanned, rows_added: added };
}

function ensureCorrespondenceSheet(ss) {
  var s = ss.getSheetByName('CORRESPONDENCE');
  if (!s) {
    s = ss.insertSheet('CORRESPONDENCE');
    s.appendRow(['person_id', 'date', 'channel', 'direction', 'subject', 'excerpt', 'thread_id', 'captured_at']);
    s.getRange('A1:H1').setFontWeight('bold').setBackground('#f0f0f0');
  }
  return s;
}

// Resolve {person_id, email} for PEOPLE rows we can reach by email. Sources, in
// order: an explicit PEOPLE.email column (future), the linked LEADS row for
// in_funnel people, and a name that is itself an address (gmail-discovered).
function resolvePeopleEmails(ss) {
  var people = ss.getSheetByName('PEOPLE');
  if (!people) return [];
  var pdata = people.getDataRange().getValues();
  if (pdata.length < 2) return [];
  var ph  = pdata[0].map(function (h) { return h.toString().toLowerCase().trim(); });
  var idc = ph.indexOf('id'), emc = ph.indexOf('email'), lpc = ph.indexOf('lead_potential'), nmc = ph.indexOf('name');

  var leadEmail = {};
  var leads = ss.getSheetByName('LEADS');
  if (leads) {
    var ld = leads.getDataRange().getValues();
    if (ld.length > 1) {
      var lh = ld[0].map(function (h) { return h.toString().toLowerCase().trim(); });
      var lidc = lh.indexOf('id'), lemc = lh.indexOf('email');
      if (lidc !== -1 && lemc !== -1) {
        for (var i = 1; i < ld.length; i++) {
          if (ld[i][lemc]) leadEmail[ld[i][lidc]] = ld[i][lemc].toString().toLowerCase().trim();
        }
      }
    }
  }

  var isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var out = [];
  for (var r = 1; r < pdata.length; r++) {
    var pid = pdata[r][idc];
    if (!pid) continue;
    var email = (emc !== -1 && pdata[r][emc]) ? pdata[r][emc].toString().toLowerCase().trim() : '';
    if (!email && lpc !== -1) {
      var m = (pdata[r][lpc] || '').toString().match(/in_funnel:(\S+)/);
      if (m && leadEmail[m[1]]) email = leadEmail[m[1]];
    }
    if (!email && nmc !== -1) {
      var nm = (pdata[r][nmc] || '').toString().toLowerCase().trim();
      if (isEmail.test(nm)) email = nm;
    }
    if (email && isEmail.test(email)) out.push({ person_id: pid, email: email });
  }
  return out;
}

// Trash threads matching senders/query. DRY-RUN unless confirm=1 (so a stray
// prefetch of the GET can never delete mail). params: senders (csv) OR q,
// max (≤500), confirm.
function cleanupGmail(ss, config, params) {
  var senders = (params.senders || '').toString().split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var q = (params.q || '').toString().trim();
  if (!q) {
    if (!senders.length) return { error: 'provide senders=a@x.com,b@y.com (or q=<gmail query>)' };
    q = '(' + senders.map(function (s) { return 'from:' + s; }).join(' OR ') + ') in:inbox';
  }
  var cap = Math.min(parseInt(params.max) || 200, 500);
  var threads = [], off = 0;
  while (threads.length < cap) {
    var batch = GmailApp.search(q, off, Math.min(100, cap - threads.length));
    if (!batch.length) break;
    threads = threads.concat(batch);
    off += batch.length;
    if (batch.length < 100) break;
  }
  if ((params.confirm || '').toString() !== '1') {
    return { dry_run: true, query: q, would_trash: threads.length,
             sample: threads.slice(0, 10).map(function (t) { return t.getFirstMessageSubject(); }),
             hint: 'add &confirm=1 to actually trash' };
  }
  for (var i = 0; i < threads.length; i += 100) {
    GmailApp.moveThreadsToTrash(threads.slice(i, i + 100));
  }
  var now = new Date();
  writeStateKey(ss.getSheetByName('SYSTEM_STATE'), 'last_gmail_cleanup', now.toISOString(), now, 'gmail_cleanup');
  return { status: 'success', trashed: threads.length, query: q };
}

// Install a Gmail filter so future mail from a sender is auto-handled. Talks to
// the Gmail REST API directly with the script's own OAuth token (no advanced
// service needed — GmailApp already grants the full mail scope). params:
//   from    (address or domain — required)
//   action  trash | archive | label
//   label   (for action=label) the label name, default 'unsubscribe'
//   keep_inbox=1  (for action=label) add the label but DON'T archive — mail stays
//                 in the inbox AND gets the label (the right default for signal).
function makeGmailFilter(params) {
  var from = (params.from || '').toString().trim();
  if (!from) return { error: 'provide from=<address or domain>' };
  var action = (params.action || 'trash').toString();
  var addLabelIds = [], removeLabelIds = [];
  if (action === 'trash')        { addLabelIds = ['TRASH']; }
  else if (action === 'archive') { removeLabelIds = ['INBOX']; }
  else if (action === 'label')   {
    addLabelIds = [ensureUserLabelId(params.label || 'unsubscribe')];
    if ((params.keep_inbox || '').toString() !== '1') removeLabelIds = ['INBOX'];
  }
  else { return { error: 'action must be trash | archive | label' }; }

  var res = gmailApi_('post', 'settings/filters',
    { criteria: { from: from }, action: { addLabelIds: addLabelIds, removeLabelIds: removeLabelIds } });
  if (res.error) return { error: 'filter create failed: ' + JSON.stringify(res.error) };
  return { status: 'success', filter_id: res.id, from: from, action: action, keep_inbox: (params.keep_inbox || '') === '1' };
}

// Resolve (creating if needed) a user label name → its Gmail API label id.
function ensureUserLabelId(name) {
  var labels = (gmailApi_('get', 'labels') || {}).labels || [];
  var hit = labels.filter(function (l) { return l.name === name; })[0];
  if (hit) return hit.id;
  var created = gmailApi_('post', 'labels',
    { name: name, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
  return created.id;
}

// Gmail REST helper — authenticates with ScriptApp.getOAuthToken() (carries the
// mail.google.com scope GmailApp already requires), so no advanced service / no
// extra OAuth scopes. Returns the parsed JSON body.
function gmailApi_(method, path, payload) {
  var opts = {
    method: method,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    contentType: 'application/json',
    muteHttpExceptions: true
  };
  if (payload) opts.payload = JSON.stringify(payload);
  var resp = UrlFetchApp.fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, opts);
  return JSON.parse(resp.getContentText() || '{}');
}

// Owner runs this ONCE in the Apps Script editor: forces the Gmail OAuth consent
// (GmailApp + Gmail advanced service) and returns a small read so it's clear it
// worked. After this, the gmail routes and the ingestion Worker can read/act.
function setupGmailAccess() {
  return { granted: true, sample: gmailSenderStats({ scan: '50', top: '15' }) };
}

// ============================================================================
// NOTES-TO-ALARMS  (T021)
//
// Deterministic, explicit-intent parser: a note must carry a reminder/alarm
// verb AND a resolvable time before it becomes an alarm. "remind me to spray
// the bbq at dawn" → 06:00; "set a timer for 20 minutes" → now+20m. Casual
// mentions ("met him at 3pm") never fire because the intent gate fails.
// ============================================================================

const ALARM_KEYWORD_TIMES = {
  midnight: '00:00', dawn: '06:00', sunrise: '06:00', morning: '07:00',
  noon: '12:00', midday: '12:00', afternoon: '14:00', evening: '19:00',
  dusk: '20:00', sunset: '20:00', night: '21:00', bedtime: '22:00'
};

function parseAlarmIntent(text, config) {
  if (!text) return null;
  const t = text.toString().toLowerCase();

  // 1) Intent gate — must look like a request to be reminded / woken.
  const intent = /\b(remind me|wake me|wake up at|set (an? )?alarm|set (an? )?timer|alarm (for|at)|timer for)\b/.test(t);
  if (!intent) return null;

  let time = null;
  const tz = (config && config['timezone']) || 'America/Toronto';

  // 2) Relative — "in 20 minutes", "for 2 hours", "timer for 20 mins"
  let m = t.match(/\b(?:in|for)\s+(\d+)\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/);
  if (m) {
    const n = parseInt(m[1]);
    const addMin = /hour|hr/.test(m[2]) ? n * 60 : n;
    const nowHM = Utilities.formatDate(new Date(), tz, 'HH:mm').split(':');
    let mins = (parseInt(nowHM[0]) * 60 + parseInt(nowHM[1]) + addMin) % 1440;
    if (mins < 0) mins += 1440;
    time = ('0' + Math.floor(mins / 60)).slice(-2) + ':' + ('0' + (mins % 60)).slice(-2);
  }

  // 3) Explicit clock — "7am", "7:30 pm", "at 14:30", "at 6"
  if (!time) {
    m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (m) {
      let h = parseInt(m[1]) % 12;
      if (m[3] === 'pm') h += 12;
      time = ('0' + h).slice(-2) + ':' + (m[2] || '00');
    } else {
      m = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
      if (m) {
        const h = parseInt(m[1]);
        if (h >= 0 && h <= 23) time = ('0' + h).slice(-2) + ':' + (m[2] || '00');
      }
    }
  }

  // 4) Keyword times — dawn / noon / bedtime …
  if (!time) {
    for (const k in ALARM_KEYWORD_TIMES) {
      if (new RegExp('\\b' + k + '\\b').test(t)) { time = ALARM_KEYWORD_TIMES[k]; break; }
    }
  }

  if (!time) return null;

  // Label — strip the boilerplate, keep the substance.
  let label = text.toString()
    .replace(/\b(please\s+)?(remind me( to| that)?|wake me( up)?|set (an? )?alarm( for| at)?|set (an? )?timer( for)?|timer for|alarm (for|at))\b/gi, '')
    .replace(/\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/gi, '')
    .replace(/\bin\s+\d+\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/gi, '')
    .replace(new RegExp('\\b(' + Object.keys(ALARM_KEYWORD_TIMES).join('|') + ')\\b', 'gi'), '')
    .replace(/\s+/g, ' ').trim()
    .replace(/[\s,]*\b(at|for|in|to|the|a)\b[\s,]*$/i, '').trim();  // drop dangling prepositions
  if (!label) label = 'Floyd';

  return { time, label: label.slice(0, 40) };
}

function maybeCreateAlarmFromNote(text, ss, config) {
  const parsed = parseAlarmIntent(text, config);
  if (!parsed) return null;
  const base  = (config['checkin_url'] || 'https://floyd-checkin.aitchisonpeter.workers.dev/').replace(/\/+$/, '/');
  const token = getApiSecret(config) || '';
  const url   = base + '?key=' + encodeURIComponent(token)
              + '&type=alarm&time=' + encodeURIComponent(parsed.time)
              + '&label=' + encodeURIComponent(parsed.label);
  UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  writeStateKey(ss.getSheetByName('SYSTEM_STATE'), 'last_note_alarm',
                parsed.time + ' · ' + parsed.label, new Date(), 'notes_to_alarms');
  return parsed;
}

// ============================================================================
// NOTIFICATION PARSERS
// ============================================================================

function parseNotificationWithRules(ss, packageName, notification, now, config) {
  const parsersSheet = ss.getSheetByName('NOTIFICATION_PARSERS');
  if (!parsersSheet) return;

  const notifText  = (notification.text  || '').toString();
  const notifTitle = (notification.title || '').toString();
  const searchText = notifTitle + ' ' + notifText;

  const data = parsersSheet.getDataRange().getValues();
  if (data.length <= 1) return;

  const stateSheet = ss.getSheetByName('SYSTEM_STATE');
  if (!stateSheet) return;
  const stateData = stateSheet.getDataRange().getValues();

  const transforms = loadTransformRegistry(ss);

  data.slice(1).forEach(row => {
    const rulePackage  = (row[0] || '').toString().trim();
    const rulePattern  = (row[1] || '').toString().trim();
    const extractGroup = row[2] !== '' ? parseInt(row[2]) : 1;
    const targetKey    = (row[3] || '').toString().trim();
    const transformKey = (row[4] || 'none').toString().trim().toLowerCase();

    if (!rulePattern || !targetKey) return;
    if (rulePackage !== '*' && rulePackage !== packageName) return;

    let regex;
    try { regex = new RegExp(rulePattern, 'i'); } catch(e) { return; }

    const match = searchText.match(regex);
    if (!match) return;

    let value = (match[extractGroup] !== undefined ? match[extractGroup] : match[0]) || '';
    value = applyTransform(value, transformKey, transforms, stateData, targetKey, now, config);

    let found = false;
    for (let i = 1; i < stateData.length; i++) {
      if (stateData[i][0] && stateData[i][0].toString() === targetKey) {
        stateSheet.getRange(i + 1, 2).setValue(value);
        stateSheet.getRange(i + 1, 3).setValue(now.toISOString());
        stateSheet.getRange(i + 1, 4).setValue('notification_parser');
        stateData[i][1] = value;
        stateData[i][2] = now.toISOString();
        found = true;
        break;
      }
    }
    if (!found) {
      stateSheet.appendRow([targetKey, value, now.toISOString(), 'notification_parser']);
      stateData.push([targetKey, value, now.toISOString(), 'notification_parser']);
    }
  });
}

function loadTransformRegistry(ss) {
  const sheet = ss.getSheetByName('TRANSFORM_REGISTRY');
  if (!sheet) return {};
  const transforms = {};
  sheet.getDataRange().getValues().slice(1).forEach(row => {
    if (row[0]) transforms[row[0].toString().toLowerCase()] = {
      operation: row[1] || 'none',
      param:     row[2] || '',
      status:    row[3] || 'active'
    };
  });
  return transforms;
}

function applyTransform(value, transformKey, transforms, stateData, targetKey, now, config) {
  if (!transformKey || transformKey === 'none') return value;

  const transform = transforms[transformKey];
  if (!transform || transform.status !== 'active') {
    switch (transformKey) {
      case 'remove_commas':    return value.replace(/,/g, '');
      case 'uppercase':        return value.toUpperCase();
      case 'lowercase':        return value.toLowerCase();
      case 'trim':             return value.trim();
      case 'accumulate_today': return accumulateToday(value, stateData, targetKey, now, config);
      default:                 return value;
    }
  }

  switch (transform.operation) {
    case 'regex_replace': {
      const parts = transform.param.split('→');
      if (parts.length === 2) return value.replace(new RegExp(parts[0], 'g'), parts[1]);
      return value;
    }
    case 'accumulate':    return accumulateToday(value, stateData, targetKey, now, config);
    case 'math': {
      const num = parseFloat(value.replace(/,/g, '')) || 0;
      const op  = transform.param;
      if (op.startsWith('*')) return (num * parseFloat(op.slice(1))).toFixed(2);
      if (op.startsWith('+')) return (num + parseFloat(op.slice(1))).toFixed(2);
      if (op.startsWith('-')) return (num - parseFloat(op.slice(1))).toFixed(2);
      return value;
    }
    case 'prefix':    return transform.param + value;
    case 'suffix':    return value + transform.param;
    case 'uppercase': return value.toUpperCase();
    case 'lowercase': return value.toLowerCase();
    case 'trim':      return value.trim();
    default:          return value;
  }
}

function accumulateToday(value, stateData, targetKey, now, config) {
  const resetHour  = parseInt((config && config['day_reset_hour']) || '5') || 5;
  const shiftedNow = new Date(now.getTime() - resetHour * 60 * 60 * 1000);
  const todayDate  = shiftedNow.toISOString().substring(0, 10);

  let prevTotal = 0;
  for (let i = 1; i < stateData.length; i++) {
    if (stateData[i][0] && stateData[i][0].toString() === targetKey) {
      const storedTs = stateData[i][2] ? stateData[i][2].toString() : '';
      try {
        if (storedTs) {
          const storedDate = new Date(storedTs);
          if (!isNaN(storedDate.getTime())) {
            const shiftedStored = new Date(storedDate.getTime() - resetHour * 60 * 60 * 1000).toISOString().substring(0, 10);
            if (shiftedStored === todayDate) {
              prevTotal = parseFloat((stateData[i][1] || '0').toString().replace(/[^0-9.]/g, '')) || 0;
            }
          }
        }
      } catch(e) {}
      break;
    }
  }
  return (prevTotal + (parseFloat(value.replace(/,/g, '')) || 0)).toFixed(2);
}

// ============================================================================
// QUALIFICATION / AGING
// ============================================================================

function ageDormantEntries(ss, cutoff30DaysAlive) {
  const logSheet = ss.getSheetByName('PERSONAL_LOG');
  if (!logSheet) return;
  const data = logSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const da        = parseInt(data[i][0]);
    const tag       = (data[i][4] || '').toString();
    const qualified = (data[i][11] || '').toString().toLowerCase();
    const status    = (data[i][9]  || '').toString().toLowerCase();
    if (qualified === 'true' || status === 'promoted' || tag === '#unresolved' || tag === '#session') continue;
    if (da >= cutoff30DaysAlive || qualified !== 'false') continue;
    logSheet.getRange(i + 1, 5).setValue('#unresolved');
    logSheet.getRange(i + 1, 12).setValue('dormant');
  }
}

// ============================================================================
// VALIDATION
// ============================================================================

function loadValidTags(ss) {
  const sheet = ss.getSheetByName('LOG_RULES');
  if (!sheet) return [];
  return sheet.getDataRange().getValues().slice(1)
    .map(row => row[0])
    .filter(tag => tag && tag.toString().startsWith('#'));
}

function validateEntry(entry, validTags) {
  if (!entry) throw new Error('Missing entry');
  if (!entry.tag) throw new Error('Missing tag');
  if (entry.value === undefined || entry.value === null || entry.value === '') throw new Error('Missing value');
  if (entry.type) {
    if (!['log', 'state_update', 'promotion'].includes(entry.type)) throw new Error('Invalid type: ' + entry.type);
  }
  if (validTags && validTags.length > 0 && !validTags.includes(entry.tag)) {
    const closest = validTags.find(t => t.includes(entry.tag) || entry.tag.includes(t));
    throw new Error('Invalid tag: ' + entry.tag + (closest ? '. Did you mean ' + closest + '?' : '. Add to LOG_RULES.'));
  }
}

function loadAutoQualifyTags(ss) {
  const sheet = ss.getSheetByName('LOG_RULES');
  if (!sheet) return [];
  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().toLowerCase().trim());
  const tagCol  = headers.indexOf('tag');
  const aqCol   = headers.indexOf('auto_qualify');
  if (tagCol === -1 || aqCol === -1) return [];
  return data.slice(1).filter(r => r[aqCol] === true || r[aqCol] === 'true').map(r => r[tagCol]);
}

function logValidationIssue(issue, ss) {
  let logSheet = ss.getSheetByName('VALIDATION_LOG');
  if (!logSheet) {
    logSheet = ss.insertSheet('VALIDATION_LOG');
    logSheet.appendRow(['Timestamp', 'AI', 'Issue Type', 'Entry', 'Message', 'Resolved']);
    logSheet.getRange('A1:F1').setFontWeight('bold').setBackground('#f0f0f0');
  }
  logSheet.appendRow([new Date().toISOString(), issue.ai || 'unknown', issue.type, JSON.stringify(issue.entry).substring(0, 200), issue.message, 'false']);
}

// ============================================================================
// LOG RULES
// ============================================================================

function applyLogRules(ss, tag) {
  const sheet = ss.getSheetByName('LOG_RULES');
  if (!sheet) return;
  const rules = {};
  sheet.getDataRange().getValues().slice(1).forEach(r => {
    if (r[0]) rules[r[0]] = { retention: r[1] || 'forever', max_entries: r[2] !== '' ? parseInt(r[2]) : null, action: r[3] || 'keep' };
  });

  const rule = rules[tag];
  if (!rule || rule.action === 'keep' || rule.retention === 'forever') return;

  const logSheet = ss.getSheetByName('PERSONAL_LOG');
  const data     = logSheet.getDataRange().getValues();

  // Collect the row indexes to remove (ascending), then archive-then-delete.
  let toDelete = [];
  if (rule.action === 'delete') {
    for (let i = 1; i < data.length; i++) { if (data[i][4] === tag) toDelete.push(i); }
  } else if (rule.retention === 'days' && rule.action === 'expire' && rule.max_entries !== null) {
    // TRUE day-based window: with retention='days', col3 is a DAY COUNT, not a
    // row count. Every row of this tag older than N days expires (archived
    // first), no matter how many — a real 30-day window, not "newest 30 rows".
    // Timestamp is PERSONAL_LOG col B (index 1, ISO string). Rows with an
    // unparseable date are left alone (never expired on ambiguous data).
    const cutoff = Date.now() - rule.max_entries * 86400000;
    for (let i = 1; i < data.length; i++) {
      if (data[i][4] !== tag) continue;
      const ts = new Date(data[i][1]).getTime();
      if (!isNaN(ts) && ts < cutoff) toDelete.push(i);
    }
  } else if (rule.action === 'replace' || rule.max_entries !== null) {
    // Count-based retention (living snapshots: latest/forever + max_entries).
    const keep    = rule.max_entries !== null ? rule.max_entries : 1;
    const tagRows = [];
    for (let i = 1; i < data.length; i++) { if (data[i][4] === tag) tagRows.push(i); }
    toDelete = tagRows.slice(0, Math.max(0, tagRows.length - keep));
  }
  if (!toDelete.length) return;

  // Raw-capture principle (T037): expire/delete streams are real history —
  // copy the FULL row to PERSONAL_LOG_ARCHIVE before it's removed so raw can
  // never be silently lost. Distilled can be re-derived from raw; raw can never
  // be re-derived from distilled. Living snapshots (replace: #location,
  // #odometer, #system_snapshot, #report, #session) are current-value mirrors,
  // not history — those keep their old drop-on-supersede behaviour, no archive.
  if (rule.action === 'expire' || rule.action === 'delete') {
    archiveLogRows(ss, toDelete.map(i => data[i]));
  }

  // Delete bottom-up so earlier indexes stay valid.
  for (let i = toDelete.length - 1; i >= 0; i--) logSheet.deleteRow(toDelete[i] + 1);
}

// Copy full PERSONAL_LOG rows into PERSONAL_LOG_ARCHIVE before applyLogRules
// removes them. Lazily creates the tab, mirroring PERSONAL_LOG's header plus a
// trailing archived_at stamp. Batched setValues — never one appendRow per row.
// Never read on any open surface; the archive is write-mostly cold storage.
function archiveLogRows(ss, rows) {
  if (!rows || !rows.length) return 0;
  var arch = ss.getSheetByName('PERSONAL_LOG_ARCHIVE');
  if (!arch) {
    arch = ss.insertSheet('PERSONAL_LOG_ARCHIVE');
    var src   = ss.getSheetByName('PERSONAL_LOG');
    var width = src ? src.getLastColumn() : rows[0].length;
    var header = src ? src.getRange(1, 1, 1, width).getValues()[0]
                     : rows[0].map(function (_, i) { return 'col' + (i + 1); });
    header = header.concat(['archived_at']);
    arch.appendRow(header);
    arch.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#f0f0f0');
  }
  var stamp = new Date().toISOString();
  var out   = rows.map(function (r) { return r.concat([stamp]); });
  arch.getRange(arch.getLastRow() + 1, 1, out.length, out[0].length).setValues(out);
  return out.length;
}

// ============================================================================
// SYSTEM DATA — dashboard
// ============================================================================

function getSystemData(ss, config) {
  const stateSheet = ss.getSheetByName('SYSTEM_STATE');
  const state      = {};
  stateSheet.getDataRange().getValues().slice(1).forEach(r => {
    if (r[0] && r[1] !== '' && r[1] !== null) state[r[0]] = r[1];
  });

  const rawBalance = parseFloat((state['spendable_balance'] || '0').toString().replace(/[^0-9.-]+/g, ''));
  const daysLeft   = getDaysRemaining();
  if (rawBalance > 0) state['daily_allowance'] = '$' + (rawBalance / daysLeft).toFixed(2);

  const locInfo = determineMode(state['current_location'] || '', config);
  state['system_mode']     = locInfo.mode;
  state['location_city']   = locInfo.city;
  state['location_icon']   = locInfo.icon;
  const currentContext     = resolveTaskContext(locInfo.mode, config);
  state['current_context'] = currentContext;
  // NOTE: the Pi presence push is intentionally NOT done here. getSystemData is a
  // read route (now fronted by the gateway's KV cache, so a side-effect here fires
  // unreliably anyway). Presence freshness is owned by the floydModeHeartbeat
  // time-trigger (see floydModePush.js) — a pure read stays a pure read.

  // Partner presence (alone vs together) — a first-class surfacing variable.
  // Computed once here so task ordering below can weight by it.
  const presence = computePartnerPresence(ss, config);

  const logSheet = ss.getSheetByName('PERSONAL_LOG');
  if (logSheet) {
    const logData = logSheet.getDataRange().getValues();
    for (let i = logData.length - 1; i >= 1; i--) {
      if (logData[i][4] === '#note' && logData[i][5]) { state['notes'] = logData[i][5].toString(); break; }
    }
  const pc = computePartnerCycle(ss, config);
  if (pc) {
    state['partner_cycle_phase']     = pc.current_phase;
    state['partner_cycle_day']       = pc.current_cycle_day;
    state['partner_days_until_next'] = pc.days_until_next;
    syncPartnerCycleToState(ss, pc);  // keep the stored mirror fresh for direct readers
  }
  }

  ['owner_birthday','owner_name','owner_id','partner_id','partner_name','app_title',
   'touch_icon','favicon','voice_lang','maps_url','accent_color'].forEach(k => {
    if (config[k]) state['_' + k] = config[k];
  });

  state['_themes'] = {
    [config['home_mode'] || 'home']: {
      background: config['home_theme_background'] || '#000',
      card:       config['home_theme_card']       || 'rgba(0,0,0,0.85)',
      label:      config['home_theme_label']      || 'rgba(255,255,255,0.5)',
      text:       config['home_theme_text']       || '#fff'
    },
    [config['second_space_mode'] || 'second']: {
      background: config['second_space_theme_background'] || '#000',
      card:       config['second_space_theme_card']       || 'rgba(0,0,0,0.85)',
      label:      config['second_space_theme_label']      || 'rgba(255,255,255,0.5)',
      text:       config['second_space_theme_text']       || '#fff'
    },
    [config['default_mode'] || 'third']: {
      background: config['default_theme_background'] || '#000',
      card:       config['default_theme_card']       || 'rgba(0,0,0,0.85)',
      label:      config['default_theme_label']      || 'rgba(255,255,255,0.5)',
      text:       config['default_theme_text']       || '#111'
    }
  };

  const tasksSheet = ss.getSheetByName('TASKS');
  if (tasksSheet) {
    const taskData    = tasksSheet.getDataRange().getValues();
    const taskHeaders = taskData[0].map(h => h.toString().toLowerCase().trim());
    const statusCol   = taskHeaders.indexOf('status');
    const contextCol  = taskHeaders.indexOf('context');
    const keyCol      = taskHeaders.indexOf('key');
    const metaCol     = taskHeaders.indexOf('meta');
    const idCol       = taskHeaders.indexOf('id');

    const openTasks = taskData.slice(1).filter(r => r[idCol || 0] && r[statusCol >= 0 ? statusCol : 3] === 'open');

    const contextTasks = openTasks.filter(r => {
      const ctx = contextCol >= 0 ? (r[contextCol] || 'anywhere').toString().toLowerCase() : 'anywhere';
      return ctx === 'anywhere' || ctx === currentContext;
    });

    // Sort by presence-fit first (soft — reorders, never hides), then priority.
    // Alone (she's away) → solo/deep-work floats up; together (she's home) →
    // together/any floats up and solo grind sinks. meta carries `presence:solo|
    // together|any` (default any/neutral).
    const getMeta = (r) => metaCol >= 0 ? r[metaCol].toString() : '';
    const getPri  = (r) => parseInt((getMeta(r).match(/priority:(\d+)/) || [])[1] || '99');
    const presenceOf = (r) => { const m = getMeta(r).match(/presence:(solo|together|any)/); return m ? m[1] : 'any'; };
    const presWeight = (r) => {
      const p = presenceOf(r);
      if (p === 'any') return 0;
      if (presence && presence.status === 'home') return p === 'together' ? -1 : 1; // together time
      return p === 'solo' ? -1 : 1;                                                 // alone time
    };
    contextTasks.sort((a, b) => (presWeight(a) * 1000 + getPri(a)) - (presWeight(b) * 1000 + getPri(b)));

    state['open_task_count']    = openTasks.length;
    state['context_task_count'] = contextTasks.length;

    if (contextTasks[0]) {
      state['next_task']         = keyCol >= 0 ? contextTasks[0][keyCol] : contextTasks[0][1];
      state['next_task_context'] = contextCol >= 0 ? (contextTasks[0][contextCol] || 'anywhere').toString() : 'anywhere';
    }
  }

  const birthday  = config['owner_birthday'] || '1981-01-01';
  const daysAlive = Math.floor((new Date() - new Date(birthday)) / 86400000);
  const alerts    = buildCalendarAlerts(ss, daysAlive);
  if (alerts.length > 0) state['calendar_alert_count'] = alerts.length;

  if (logSheet) {
    const logData     = logSheet.getDataRange().getValues().slice(1);
    const unqualCount = logData.filter(r => {
      const qualified = (r[11] || '').toString().toLowerCase();
      const status    = (r[9]  || '').toString().toLowerCase();
      const tag       = (r[4]  || '').toString();
      return qualified === 'false' && status !== 'promoted' && status !== 'dormant' && tag !== '#unresolved';
    }).length;
    if (unqualCount > 0) state['unqualified_count'] = unqualCount;
  }

  // v3.4: surface unresolved validation count on dashboard
  const vlSheet = ss.getSheetByName('VALIDATION_LOG');
  if (vlSheet) {
    const vlData = vlSheet.getDataRange().getValues().slice(1);
    const unresolvedCount = vlData.filter(r => {
      if (!r[VL_COL_TIMESTAMP - 1]) return false;
      const resolved = (r[VL_COL_RESOLVED - 1] || '').toString().toLowerCase();
      return resolved !== 'true';
    }).length;
    if (unresolvedCount > 0) state['validation_error_count'] = unresolvedCount;
  }

  ['DISPLAY_CONFIG', 'ACTIONS', 'AI_TARGETS'].forEach(sheetName => {
    const s = ss.getSheetByName(sheetName);
    if (!s) return;
    const data    = s.getDataRange().getValues();
    const headers = data[0];
    state['_' + sheetName.toLowerCase()] = data.slice(1)
      .filter(r => r[0])
      .map(row => {
        const obj = {};
        headers.forEach((h, i) => { if (h) obj[h.toString().toLowerCase()] = row[i]; });
        return obj;
      });
  });
  state['current_mode'] = state['system_mode'];
  (function () {
    const bday = config['owner_birthday'] || '1981-01-01';
    const today = Math.floor((new Date() - new Date(bday)) / 86400000);
    const log = ss.getSheetByName('PERSONAL_LOG').getDataRange().getValues();
    let sum = 0, n = 0;
    for (let i = log.length - 1; i >= 1; i--) {
      if (parseInt(log[i][0]) < today - 7) break;
      if (log[i][4] === '#energy') {
        const m = String(log[i][5]).match(/(\d+(\.\d+)?)/);
        if (m) { sum += parseFloat(m[1]); n++; }
      }
    }
    if (n > 0) state['energy_baseline'] = (sum / n).toFixed(1) + '/10';
  })();

  // ── Appointments card — next few upcoming calendar items, one line ──────────
  if (alerts && alerts.length) {
    state['appointments'] = alerts.slice(0, 3).map(a => {
      const n     = a.days_until;
      const when  = n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + 'd';
      const label = (a.notes || a.key || '').toString().split('—')[0].trim().slice(0, 38) || 'event';
      return label + ' · ' + when;
    }).join('  |  ');
  }

  // ── Tasks card — open here vs total ─────────────────────────────────────────
  if (state['open_task_count'] !== undefined) {
    state['task_progress'] = (state['context_task_count'] || 0) + ' here · ' + state['open_task_count'] + ' total';
  }

  // ── Off-grid (Tuliptown) display values, formatted with units ───────────────
  if (state['solar_today_kwh'] && state['solar_today_kwh'] !== 'pending') {
    state['offgrid_solar'] = state['solar_today_kwh'] + ' kWh/m²'
      + (state['sunshine_hours_today'] && state['sunshine_hours_today'] !== 'pending'
         ? ' · ' + state['sunshine_hours_today'] + 'h sun' : '');
  }
  // power_advisory='none' means all-good → hide the card by leaving it blank.
  if (state['power_advisory'] && state['power_advisory'] !== 'none') {
    state['offgrid_advisory'] = state['power_advisory'];
  }

  // ── Partner presence (alone vs together) — mirror onto state for display ──
  // Computed early (above) into `presence`; surface its fields here too.
  if (presence) {
    state['partner_status']   = presence.status;
    state['partner_present']  = presence.present ? 'yes' : 'no';
    state['presence_posture'] = presence.posture;
    state['presence_note']    = presence.note;
    if (presence.location)   state['partner_location']  = presence.location;
    if (presence.away_until) state['partner_away_until'] = presence.away_until;
  }

  return state;
}

// ============================================================================
// CHECKIN PROMPT
// ============================================================================

function getCheckinPrompt(ss, config) {
  const ownerName  = config['owner_name']     || '';
  const ownerId    = config['owner_id']       || 'owner';
  const ownerBday  = config['owner_birthday'] || '1981-01-01';
  const daysAlive  = Math.floor((new Date() - new Date(ownerBday)) / 86400000);

  const promptSheet = ss.getSheetByName('PROMPTS');
  let template = '';
  if (promptSheet) {
    promptSheet.getDataRange().getValues().forEach(r => { if (r[0] === 'daily_checkin') template = r[1]; });
  }

  const prep      = buildCheckinPrep({}, ss, config);
  const validTags = loadValidTags(ss).join(', ');

  const triggerEnd     = config['trigger_end']     || 'lets grow';
  const triggerPause   = config['trigger_pause']   || 'lets pause';
  const triggerSkip    = config['trigger_skip']    || 'skip';
  const triggerSummary = config['trigger_summary'] || 'summary';

  const triggersBlock = '## SESSION TRIGGERS\n'
    + ownerName + ' uses specific phrases to control the session:\n\n'
    + '"' + triggerEnd     + '" -> End session. Output full import packet.\n'
    + '"' + triggerPause   + '" -> Save partial. Output partial import packet.\n'
    + '"' + triggerSkip    + '" -> Skip current question.\n'
    + '"' + triggerSummary + '" -> Recap logged so far. Do not output JSON yet.';

  // FIX 5: add {{task_id_counter}} and {{task_progress}} to replace chain
  return template
    .replace(/{{owner_name}}/g,              ownerName)
    .replace(/{{owner_id}}/g,                ownerId)
    .replace(/{{days_alive}}/g,              daysAlive)
    .replace(/{{base_url}}/g,                config['api_url'] || '')
    .replace(/{{current_context}}/g,         prep._meta.current_context || 'anywhere')
    .replace(/{{location_city}}/g,           prep._meta.location_city || '')
    .replace(/{{partner_phase}}/g,           prep.partner.phase || '')
    .replace(/{{partner_days_until_next}}/g, prep.partner.days_until_next || '')
    .replace(/{{stale_state}}/g,             Object.keys(prep.stale_state).length > 0 ? JSON.stringify(prep.stale_state, null, 2) : 'None.')
    .replace(/{{urgent_alerts}}/g,           prep.urgent_alerts.length > 0 ? JSON.stringify(prep.urgent_alerts, null, 2) : 'None.')
    .replace(/{{top_tasks}}/g,               prep.top_tasks.length > 0 ? JSON.stringify(prep.top_tasks, null, 2) : 'None.')
    .replace(/{{last_session}}/g,            prep.last_session ? prep.last_session.summary || '' : 'No previous session.')
    .replace(/{{unqualified_count}}/g,       prep.counts.unqualified.toString())
    .replace(/{{dormant_count}}/g,           prep.counts.dormant.toString())
    .replace(/{{validation_error_count}}/g,  (prep.counts.validation_errors || 0).toString())
    .replace(/{{tags_today}}/g,              prep.counts.tags_today.join(', ') || 'nothing yet')
    .replace(/{{days_alive_minus_7}}/g,      (daysAlive - 7).toString())
    .replace(/{{days_alive_minus_30}}/g,     (daysAlive - 30).toString())
    .replace(/{{valid_tags}}/g,              validTags)
    .replace(/{{task_id_counter}}/g,         prep.task_id_counter || 'T001')
    .replace(/{{task_progress}}/g,           prep.counts.context_tasks + ' open')
    .replace(/{{triggers}}/g,               triggersBlock);
}

// ============================================================================
// NOTIFICATION STATS
// ============================================================================

function updateNotificationStats(ss, packageName, notification) {
  let statsSheet = ss.getSheetByName('NOTIFICATION_STATS');
  if (!statsSheet) {
    statsSheet = ss.insertSheet('NOTIFICATION_STATS');
    statsSheet.appendRow(['package','app_name','count_today','count_week','count_month','count_all','last_seen','last_text']);
    statsSheet.getRange('A1:H1').setFontWeight('bold').setBackground('#f0f0f0');
  }
  const data = statsSheet.getDataRange().getValues();
  const now  = new Date();
  let found  = false;

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === packageName) {
      const lastSeen = data[i][6] ? new Date(data[i][6]) : null;

      let todayCount = parseInt(data[i][2]) || 0;
      let weekCount  = parseInt(data[i][3]) || 0;
      let monthCount = parseInt(data[i][4]) || 0;

      if (lastSeen) {
        if (now.toDateString() !== lastSeen.toDateString()) todayCount = 0;
        if (now.getMonth() !== lastSeen.getMonth() ||
            now.getFullYear() !== lastSeen.getFullYear()) monthCount = 0;
        // Week reset: use ISO week comparison
        if (getISOWeek(now) !== getISOWeek(lastSeen) ||
            now.getFullYear() !== lastSeen.getFullYear()) weekCount = 0;
      }
    
      statsSheet.getRange(i + 1, 3).setValue(todayCount + 1);
      statsSheet.getRange(i + 1, 4).setValue(weekCount  + 1);
      statsSheet.getRange(i + 1, 5).setValue(monthCount + 1);
      statsSheet.getRange(i + 1, 6).setValue((parseInt(data[i][5]) || 0) + 1);
      statsSheet.getRange(i + 1, 7).setValue(now.toISOString());
      if (notification && notification.text)
        statsSheet.getRange(i + 1, 8).setValue(notification.text.substring(0, 100));
      found = true;
      break;
    }
  }
  if (!found) {
    statsSheet.appendRow([
      packageName, friendlyAppName(ss, packageName),
      1, 1, 1, 1, now.toISOString(),
      notification && notification.text ? notification.text.substring(0, 100) : ''
    ]);
  }
}

function getISOWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

// ============================================================================
// HELPERS
// ============================================================================

function loadConfig(ss) {
  if (!ss) ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('CONFIG');
  if (!sheet) return {};
  const config = {};
  sheet.getDataRange().getValues().forEach(row => { if (row[0]) config[row[0]] = row[1]; });
  return config;
}

// The shared write token. Prefer Script Properties (File → Project Settings →
// Script Properties, key `API_SECRET`) — values there are never read into the
// CONFIG object and so can never leak through a context packet. Falls back to
// CONFIG.api_secret so deploying this is safe BEFORE the property is set; once
// the property exists, delete the CONFIG.api_secret row.
function getApiSecret(config) {
  try {
    const p = PropertiesService.getScriptProperties().getProperty('API_SECRET');
    if (p) return p.toString().trim();
  } catch (e) { /* properties unavailable — fall through */ }
  return (config['api_secret'] || '').toString().trim();
}

// True for any CONFIG/state key whose value must never leave the backend in a
// context packet (the read routes are unauthenticated). Defense-in-depth: even
// if CONFIG is re-added to CONTEXT_SCHEMA, secrets stay server-side.
function isSecretKey(key) {
  return /secret|token|password|api[_-]?key|apikey/i.test(String(key || ''));
}

function loadSheet(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  return data.slice(1).filter(r => r[0]).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      if (h) obj[h.toString().toLowerCase().replace(/[^a-z0-9_]/g, '_')] = row[i];
    });
    return obj;
  });
}

function writeStateKey(stateSheet, key, value, now, source) {
  const data = stateSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      stateSheet.getRange(i + 1, 2).setValue(value);
      stateSheet.getRange(i + 1, 7).setValue(now.toISOString());
      stateSheet.getRange(i + 1, 6).setValue(source);
      return;
    }
  }
  stateSheet.appendRow([key, value, 'active', 'anywhere', '', source, now.toISOString()]);
}

function ensureHeaders(sheet, headers) {
  const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getValues()[0];
  headers.forEach((h, i) => {
    if (!current[i]) sheet.getRange(1, i + 1).setValue(h);
  });
  sheet.getRange('1:1').setFontWeight('bold').setBackground('#f0f0f0');
}

function safeParseJSON(val) {
  if (!val) return null;
  try { return JSON.parse(val); } catch(e) { return null; }
}

function pickRandom(arr, n) {
  if (!arr || arr.length === 0) return [];
  return arr.slice().sort(() => Math.random() - 0.5).slice(0, Math.min(n, arr.length));
}

function getDaysRemaining() {
  const now    = new Date();
  const target = now.getDate() < 15
    ? new Date(now.getFullYear(), now.getMonth(), 15)
    : new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return Math.ceil(Math.abs(target - now) / 86400000) || 1;
}

function determineMode(input, config) {
  const homeLat      = parseFloat(config['home_lat']);
  const homeLon      = parseFloat(config['home_lon']);
  const homeRadius   = parseFloat(config['home_radius_km']);
  const secondRadius = parseFloat(config['second_space_radius_km']);
  const homeMode     = config['home_mode']         || 'home';
  const homeCity     = config['home_city']         || 'Home';
  const homeIcon     = config['home_icon']         || 'home.webp';
  const secondMode   = config['second_space_mode'] || 'second';
  const secondCity   = config['second_space_city'] || 'Second Space';
  const secondIcon   = config['second_space_icon'] || 'second.png';
  const defaultMode  = config['default_mode']      || 'third';
  const defaultCity  = config['default_city']      || 'Travelling';
  const defaultIcon  = config['default_icon']      || 'travel.png';

  if (!input) return { mode: homeMode, city: homeCity, icon: homeIcon };

  const geoMatch = input.match(/(-?\d+\.\d+)\s*[,\s-]\s*(-?\d+\.\d+)/);
  if (geoMatch) {
    const lat = parseFloat(geoMatch[1]);
    const lon = parseFloat(geoMatch[2]);
    const d   = getHaversineDistance(homeLat, homeLon, lat, lon);
    if (d <= homeRadius)   return { mode: homeMode,   city: homeCity,   icon: homeIcon };
    if (d <= secondRadius) return { mode: secondMode, city: secondCity, icon: secondIcon };
  }
  return { mode: defaultMode, city: defaultCity, icon: defaultIcon };
}

function getHaversineDistance(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// FIX 4: extract summary from #session entry if params.summary is missing
function logSession(ss, params, importedCount, ownerBirthday, now) {
  const sessSheet = ss.getSheetByName('AI_SESSIONS');
  if (!sessSheet) return;
  const daysAlive = Math.floor((now - new Date(ownerBirthday)) / 86400000);
  const tags = [...new Set((params.entries || []).map(e => e.tag).filter(Boolean))].join(', ');
  let summary = params.summary || '';
  if (!summary && params.entries) {
    const sessionEntry = params.entries.find(e => e.tag === '#session');
    if (sessionEntry) summary = sessionEntry.value || '';
  }
  sessSheet.appendRow([
    'S' + now.getTime(), now.toISOString(), params.ai || 'manual',
    params.prompt || '', summary, importedCount, daysAlive, tags
  ]);
}

function auditSession(ss, params, sheetName, updated, appended, config) {
  // CONFIG.audit_sessions toggles this debug trail. 'off' disables it entirely;
  // anything else keeps a SELF-BOUNDED trail (the default). Previously this
  // appended on every sheet write with no cap — the AI_SESSIONS growth engine
  // (13.6k rows before a one-shot trim). No CONFIG row needed: defaults apply.
  const mode = (config['audit_sessions'] || 'capped').toString().toLowerCase();
  if (mode === 'off') return;
  const sessSheet = ss.getSheetByName('AI_SESSIONS');
  if (!sessSheet) return;
  const now       = new Date();
  const ownerBday = config['owner_birthday'] || '1981-01-01';
  const daysAlive = Math.floor((now - new Date(ownerBday)) / 86400000);
  sessSheet.appendRow([
    'S' + now.getTime(), now.toISOString(), params.ai || 'repair',
    'sheet_update', sheetName + ': ' + updated + ' updated, ' + appended + ' appended',
    updated + appended, daysAlive, '#system'
  ]);
  // Self-bound so it can't regrow forever. Keep header (row 1) + newest `cap`
  // rows. Only trims once past cap + buffer, so the deleteRows call is rare
  // (amortized over many writes), not per-write.
  const cap = parseInt(config['audit_sessions_cap'], 10) || 500;
  const dataRows = sessSheet.getLastRow() - 1; // minus header
  if (dataRows > cap + 50) {
    sessSheet.deleteRows(2, dataRows - cap); // delete oldest data rows; keep header + newest cap
  }
}

// ============================================================================
// TRIGGER
// ============================================================================

function onEdit(e) {
  const logSheet = e.source.getSheetByName('LOG');
  if (!logSheet || e.range.getSheet().getName() === 'LOG') return;
  logSheet.appendRow([new Date(), e.range.getSheet().getName(), e.range.getA1Notation(), e.oldValue || '', e.value || '', 'direct_edit']);
}

// ============================================================================
// SETUP
// ============================================================================

function initFloydV3() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  if (!ss.getSheetByName('ROUTE_REGISTRY')) {
    const s = ss.insertSheet('ROUTE_REGISTRY');
    s.appendRow(['key', 'method', 'handler_type', 'config', 'status', 'notes']);
    s.getRange('A1:F1').setFontWeight('bold').setBackground('#f0f0f0');
    const routes = [
      ['context',              'GET',  'context_build', '{}',                                              'active', 'Build full context packet'],
      ['checkin_prep',         'GET',  'context_build', '{"mode":"checkin"}',                              'active', 'Checkin prep — lean surface'],
      ['checkin',              'GET',  'context_build', '{"mode":"checkin"}',                              'active', 'Get checkin prompt'],
      ['checkin_detail',       'GET',  'context_build', '{"mode":"checkin_detail"}',                       'active', 'On-demand detail — unqualified, tasks, dormant, validation_errors'],
      ['schema',               'GET',  'sheet_read',    '{"sheet":"CONTEXT_SCHEMA"}',                      'active', 'Get context schema'],
      ['tags',                 'GET',  'sheet_read',    '{"sheet":"LOG_RULES"}',                           'active', 'Get valid tags'],
      ['smart_tag',            'GET',  'scorer',        '{"sheet":"TAG_KEYWORDS"}',                        'active', 'Score text to tag'],
      ['system',               'GET',  'context_build', '{"mode":"system"}',                               'active', 'System data for dashboard'],
      ['import_entries',       'POST', 'import',        '{}',                                              'active', 'Import log entries'],
      ['sheet_update',         'POST', 'sheet_write',   '{}',                                              'active', 'Write to any sheet'],
      ['task_update',          'POST', 'sheet_write',   '{"sheet":"TASKS"}',                               'active', 'Task CRUD'],
      ['session_log',          'POST', 'sheet_write',   '{"sheet":"AI_SESSIONS"}',                         'active', 'Log AI session'],
      ['prompt_update',        'POST', 'sheet_write',   '{"sheet":"PROMPTS"}',                             'active', 'Update prompt'],
      ['cycle_reset',          'POST', 'import',        '{"auto_tag":"#cycle_start"}',                     'active', 'Log cycle reset'],
      ['/notification',        'POST', 'import',        '{"mode":"notification"}',                         'active', 'Single notification'],
      ['/notifications/batch', 'POST', 'import',        '{"mode":"notification_batch"}',                   'active', 'Batch notifications'],
      ['calendar_add',         'POST', 'sheet_write',   '{"sheet":"CALENDAR"}',                            'active', 'Add calendar event'],
      ['proposals',            'GET',  'sheet_read',    '{"sheet":"PROPOSALS"}',                           'active', 'Read evolution proposals'],
      ['evolution_read',       'GET',  'sheet_read',    '{"sheet":"EVOLUTION_LOG"}',                       'active', 'Read the free-text idea stream'],
    ];
    routes.forEach(r => s.appendRow(r));
    s.autoResizeColumns(1, 6);
    Logger.log('ROUTE_REGISTRY created');
  }

  if (!ss.getSheetByName('TRANSFORM_REGISTRY')) {
    const s = ss.insertSheet('TRANSFORM_REGISTRY');
    s.appendRow(['name', 'operation', 'param', 'status', 'notes']);
    s.getRange('A1:E1').setFontWeight('bold').setBackground('#f0f0f0');
    const transforms = [
      ['remove_commas',    'regex_replace', ',→',   'active', 'Remove commas from numbers'],
      ['accumulate_today', 'accumulate',    '',      'active', 'Add to running daily total'],
      ['uppercase',        'uppercase',     '',      'active', 'Convert to uppercase'],
      ['lowercase',        'lowercase',     '',      'active', 'Convert to lowercase'],
      ['trim',             'trim',          '',      'active', 'Trim whitespace'],
      ['multiply_100',     'math',          '*100',  'active', 'Multiply by 100'],
      ['add_tax',          'math',          '*1.13', 'active', 'Add 13% tax'],
      ['prefix_dollar',    'prefix',        '$',     'active', 'Prefix with dollar sign'],
    ];
    transforms.forEach(r => s.appendRow(r));
    s.autoResizeColumns(1, 5);
    Logger.log('TRANSFORM_REGISTRY created');
  }

  if (!ss.getSheetByName('META_HANDLERS')) {
    const s = ss.insertSheet('META_HANDLERS');
    s.appendRow(['meta_type', 'action', 'target', 'config', 'status', 'notes']);
    s.getRange('A1:F1').setFontWeight('bold').setBackground('#f0f0f0');
    const handlers = [
      ['promotion',    'sheet_write',  '',             '{"key_column":1}',                 'active', 'Write to target_sheet (upsert by target_key)'],
      ['state_update', 'state_write',  'SYSTEM_STATE', '{}',                               'active', 'Write to SYSTEM_STATE'],
      ['qualify',      'flag_row',     'PERSONAL_LOG', '{"id_column":3,"flag_column":12}', 'active', 'Mark entry qualified'],
      ['schema_update','create_sheet', '',             '{}',                               'active', 'Create a new sheet'],
    ];
    handlers.forEach(r => s.appendRow(r));
    s.autoResizeColumns(1, 6);
    Logger.log('META_HANDLERS created');
  }

  if (!ss.getSheetByName('CALENDAR')) {
    const s = ss.insertSheet('CALENDAR');
    s.appendRow(['id', 'key', 'value', 'status', 'context', 'notes', 'meta', 'updated']);
    s.getRange('A1:H1').setFontWeight('bold').setBackground('#f0f0f0');
    s.appendRow(['CAL000', 'example_event', '2026-12-31', 'inactive', 'anywhere', 'Example — set status to active', '{"notify_days_before":7,"tag":"#calendar"}', '']);
    s.autoResizeColumns(1, 8);
    Logger.log('CALENDAR created');
  }

  if (!ss.getSheetByName('APP_NAMES')) {
    const s = ss.insertSheet('APP_NAMES');
    s.appendRow(['package', 'friendly_name', 'status', 'notes']);
    s.getRange('A1:D1').setFontWeight('bold').setBackground('#f0f0f0');
    const apps = [
      ['ca.koho',                           'KOHO',      'active', ''],
      ['com.whatsapp',                      'WhatsApp',  'active', ''],
      ['com.google.android.gm',             'Gmail',     'active', ''],
      ['com.google.android.apps.messaging', 'Messages',  'active', ''],
      ['com.instagram.android',             'Instagram', 'active', ''],
      ['com.discord',                       'Discord',   'active', ''],
      ['com.spotify.music',                 'Spotify',   'active', ''],
    ];
    apps.forEach(r => s.appendRow(r));
    s.autoResizeColumns(1, 4);
    Logger.log('APP_NAMES created');
  }

  ensureProposalsSheet();  // evolution-loop PROPOSALS tab (idempotent)
  ensureLensesSheet(ss);   // context-lens definitions (T038, idempotent)

  Logger.log('Floyd v3.4 init complete.');
  return { status: 'success', message: 'Floyd v3.4 initialized' };
}

function buildLegacyContext(params, ss, config) {
  const state = {};
  ss.getSheetByName('SYSTEM_STATE').getDataRange().getValues().slice(1).forEach(r => {
    if (r[0]) state[r[0]] = r[1] ? r[1].toString() : '';
  });
  const birthday  = config['owner_birthday'] ? new Date(config['owner_birthday']).toISOString().split('T')[0] : '1981-01-01';
  const daysAlive = Math.floor((new Date() - new Date(birthday)) / 86400000);
  return {
    current_state: state,
    _meta: { generated: new Date().toISOString(), days_alive: daysAlive, version: '3.4-legacy' }
  };
}
function archiveOldSessions() {
  const KEEP = 200; // recent sessions to keep live
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const src = ss.getSheetByName('AI_SESSIONS');
  if (!src) throw new Error('AI_SESSIONS not found');

  const data = src.getDataRange().getValues();
  const header = data[0];
  const body = data.slice(1);
  if (body.length <= KEEP) { Logger.log('Nothing to archive (%s rows).', body.length); return; }

  // Full copy to archive (append, preserving any prior archive)
  let arch = ss.getSheetByName('AI_SESSIONS_ARCHIVE');
  if (!arch) { arch = ss.insertSheet('AI_SESSIONS_ARCHIVE'); arch.appendRow(header); }
  const toArchive = body.slice(0, body.length - KEEP);
  arch.getRange(arch.getLastRow() + 1, 1, toArchive.length, header.length).setValues(toArchive);

  // Rewrite live sheet: header + most recent KEEP
  const keepRows = body.slice(body.length - KEEP);
  src.clearContents();
  src.getRange(1, 1, 1, header.length).setValues([header]);
  src.getRange(2, 1, keepRows.length, header.length).setValues(keepRows);

  Logger.log('Archived %s rows, kept %s live.', toArchive.length, keepRows.length);
}
function trimBlankRows(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(sheetName + ' not found');
  const lastData = sheet.getLastRow();              // last row with content
  const maxRows = sheet.getMaxRows();               // total grid rows
  if (maxRows > lastData) {
    sheet.deleteRows(lastData + 1, maxRows - lastData);
    Logger.log('%s: removed %s blank rows.', sheetName, maxRows - lastData);
  } else {
    Logger.log('%s: no trailing blanks.', sheetName);
  }
}

function trimAllPaddedSheets() {
  ['PROMPTS', 'AI_TARGETS', 'LOG_RULES'].forEach(trimBlankRows);
}
function fixLogValueFormat() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PERSONAL_LOG');
  sh.getRange('F:F').setNumberFormat('@'); // Value column → plain text
}
function recoverCoercedRatings() {
  const DRY_RUN = false;                       // ← set to false to actually write
  const TAGS    = ['#mood', '#energy', '#sleep'];
  const TAG_COL = 5;                          // column E (1-indexed)
  const VAL_COL = 6;                          // column F (1-indexed)

  const sh   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PERSONAL_LOG');
  const data = sh.getDataRange().getValues();
  const plan = [];

  for (let i = 1; i < data.length; i++) {
    if (TAGS.indexOf(data[i][TAG_COL - 1]) === -1) continue;
    const v = data[i][VAL_COL - 1];

    let d = null;
    if (v instanceof Date) d = v;
    else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) d = new Date(v);
    if (!d || isNaN(d.getTime()) || d.getDate() !== 10) continue;  // only N/10 coercions

    const month = d.getMonth() + 1;
    if (month < 1 || month > 12) continue;
    plan.push({ row: i + 1, tag: data[i][TAG_COL - 1], newVal: month + '/10' });
  }

  if (!DRY_RUN) {
    sh.getRange(2, VAL_COL, sh.getLastRow() - 1, 1).setNumberFormat('@');  // plain text
    plan.forEach(p => sh.getRange(p.row, VAL_COL).setValue(p.newVal));
  }

  Logger.log('%s %s row(s):\n%s',
    DRY_RUN ? 'WOULD fix' : 'Fixed',
    plan.length,
    plan.map(p => `  row ${p.row}  ${p.tag} → ${p.newVal}`).join('\n') || '  (none)');
  return plan.length;
}
// Persist the freshly-computed cycle back into SYSTEM_STATE so direct readers
// (MCP context, nightly brief, conversational check-in) don't run on a stale
// mirror. Guarded: only writes the cells that actually changed (≈once/day at
// rollover), so it adds no meaningful write load to read routes.
function syncPartnerCycleToState(ss, pc) {
  if (!pc) return;
  const stateSheet = ss.getSheetByName('SYSTEM_STATE');
  if (!stateSheet) return;
  const want = {
    partner_cycle_phase:     pc.current_phase,
    partner_cycle_day:       pc.current_cycle_day,
    partner_days_until_next: pc.days_until_next
  };
  const cur  = {};
  stateSheet.getDataRange().getValues().slice(1).forEach(r => { cur[r[0]] = r[1]; });
  const now  = new Date();
  Object.keys(want).forEach(k => {
    if (want[k] === '' || want[k] === null || want[k] === undefined) return;
    if (String(cur[k]) !== String(want[k])) writeStateKey(stateSheet, k, want[k], now, 'cycle_compute');
  });
}

function computePartnerCycle(ss, config) {
  const MS = 86400000;
  const partnerId  = (config['partner_id'] || 'esther').toLowerCase();
  const stateSheet = ss.getSheetByName('PARTNER_STATE');
  const cycleSheet = ss.getSheetByName('PARTNER_CYCLE');

  // average length (fallback 28)
  let avgLen = 28;
  if (stateSheet) {
    stateSheet.getDataRange().getValues().forEach(r => {
      if (r[1] === 'average_cycle_length' && r[2]) avgLen = parseInt(r[2]) || avgLen;
    });
  }

  // anchor = most recent #cycle_start for the partner (timestamp = the start date)
  let anchor = null;
  const log = ss.getSheetByName('PERSONAL_LOG').getDataRange().getValues();
  for (let i = log.length - 1; i >= 1; i--) {           // cols: D=person(3) E=tag(4) B=ts(1)
    if (String(log[i][4]) === '#cycle_start' &&
        String(log[i][3]).toLowerCase() === partnerId) { anchor = new Date(log[i][1]); break; }
  }
  // fallback: stored current_cycle_start (serial number or date)
  if ((!anchor || isNaN(anchor)) && stateSheet) {
    stateSheet.getDataRange().getValues().forEach(r => {
      if (r[1] === 'current_cycle_start' && r[2] !== '') {
        anchor = (r[2] instanceof Date) ? r[2]
               : (typeof r[2] === 'number') ? new Date(Date.UTC(1899, 11, 30) + r[2] * MS)
               : new Date(r[2]);
      }
    });
  }
  if (!anchor || isNaN(anchor)) return null;

  const now          = new Date();
  const daysSince    = Math.floor((now - anchor) / MS);
  const cyclesPassed = Math.max(0, Math.floor(daysSince / avgLen));
  const currentStart = new Date(anchor.getTime() + cyclesPassed * avgLen * MS);
  const day          = Math.floor((now - currentStart) / MS) + 1;     // 1-based
  const nextStart    = new Date(anchor.getTime() + (cyclesPassed + 1) * avgLen * MS);
  const daysUntil    = Math.ceil((nextStart - now) / MS);

  let phase = '';
  if (cycleSheet) {
    cycleSheet.getDataRange().getValues().forEach(r => { if (parseInt(r[1]) === day) phase = r[2]; });
  }

  return {
    current_cycle_start:  currentStart.toISOString().slice(0, 10),
    current_cycle_day:    day,
    average_cycle_length: avgLen,
    predicted_next_start: nextStart.toISOString().slice(0, 10),
    days_until_next:      daysUntil,
    current_phase:        phase
  };
}
function promoteEntryToState(ss, entry, config, now) {
  const rulesSheet = ss.getSheetByName('PROMOTION_RULES');
  if (!rulesSheet) return;
  const stateSheet = ss.getSheetByName('SYSTEM_STATE');
  const tag = entry.tag || '#note';
  const val = entry.value != null ? entry.value.toString() : '';
  if (!val) return;
  const active = v => v === true || v === 'true' || v === 1 || v === '1';

  rulesSheet.getDataRange().getValues().slice(1)
    // Log_Key(0) | Tag(1) | Person(2) | Active(3) | Promote_To(4)
    .filter(r => r[1] === tag && active(r[3]) && !r[4] && r[0])
    .forEach(r => writeStateKey(stateSheet, r[0], val, now, 'promotion'));
}
function fixStateValueFormat() {
  SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName('SYSTEM_STATE')
    .getRange('B:B').setNumberFormat('@'); // Value column → plain text
}
/**
 * Floyd one-shot sheet cleanup — 2026-06-14
 * ──────────────────────────────────────────────────────────────────────────
 * Paste this whole file into the Floyd Apps Script project as a new script
 * file, then run cleanupFloyd() from the editor.
 *
 *  • DRY_RUN = true (default): changes NOTHING — only logs what it WOULD do.
 *    Run it once, read the Execution log, then flip DRY_RUN = false and re-run.
 *  • NEVER touches PERSONAL_LOG.
 *  • Idempotent: safe to run more than once.
 *
 * Before the real run: File → Download a fresh copy of the workbook as backup
 * (the local FLOYD 2.0.xlsx snapshot already holds AI_SESSIONS through Jun 12).
 * ──────────────────────────────────────────────────────────────────────────
 */
const DRY_RUN        = false;   // ← set to false to actually apply changes
const KEEP_SESSIONS  = 500;    // AI_SESSIONS data rows to retain (newest)
const RETIRE_N8N     = false;  // true = also purge n8n infra tasks + N8N_* state
                               //        keys. Leave false to keep n8n scoped to
                               //        complex_workflows_only (current roadmap).

// Zero-use, non-wired tags identified from PERSONAL_LOG analysis (safe to drop).
// Kept on purpose: #odometer/#revisit/#deadline (wired into PROMOTION_RULES),
// #notification_pattern (canonical documented tag), and every tag with real use.
const DEAD_TAGS = ['#system_update', '#notification_setup', '#notification_fix',
                   '#notification_dev', '#summary', '#insight', '#lucy'];

function cleanupFloyd() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const log = [];
  const L = (m) => { log.push(m); Logger.log(m); };
  L('=== Floyd cleanup ' + new Date().toISOString() + ' | DRY_RUN=' + DRY_RUN +
    ' | RETIRE_N8N=' + RETIRE_N8N + ' ===');

  const PROTECTED = ['PERSONAL_LOG'];

  // 1. Trim trailing empty rows on every sheet (kills the AI_TARGETS/PROMPTS/
  //    LOG_RULES ~1000-row padding and any other padded sheet).
  ss.getSheets().forEach(function (sh) {
    const name = sh.getName();
    if (PROTECTED.indexOf(name) !== -1) return;
    const last = sh.getLastRow(), max = sh.getMaxRows();
    if (last > 0 && max > last) {
      L('trim ' + name + ': delete ' + (max - last) + ' empty rows');
      if (!DRY_RUN) sh.deleteRows(last + 1, max - last);
    }
  });

  // 2. AI_SESSIONS: keep header + newest KEEP_SESSIONS rows.
  const sess = ss.getSheetByName('AI_SESSIONS');
  if (sess) {
    const n = sess.getLastRow() - 1;
    if (n > KEEP_SESSIONS) {
      const del = n - KEEP_SESSIONS;
      L('AI_SESSIONS: ' + n + ' rows -> keep ' + KEEP_SESSIONS + ', delete oldest ' + del);
      if (!DRY_RUN) sess.deleteRows(2, del);
    } else {
      L('AI_SESSIONS: ' + n + ' rows (<= ' + KEEP_SESSIONS + '), nothing to trim');
    }
  }

  // 3. CONTEXT_SCHEMA: remove dead assembly rows.
  deleteRowsWhere(ss, 'CONTEXT_SCHEMA', 0,
    function (v) { return v === 'ENGINE_SPECS' || v === 'PARTNER'; }, L);

  // 4. CONFIG: fix stale base_url (GitHub Pages -> live Cloudflare Pages host).
  setKeyValue(ss, 'CONFIG', 0, 1, 'base_url', 'https://floyd.tuliptown.ca', L);

  // 5. LOG_RULES: add #van (validates the smart-tag keyword we added) + drop dead tags.
  ensureLogRule(ss, '#van', ['#van', 'forever', 'keep', 'keep', 'Van life / maintenance'], L);
  deleteRowsWhere(ss, 'LOG_RULES', 0,
    function (v) { return DEAD_TAGS.indexOf(v) !== -1; }, L);

  // 6. Drop the empty, unused JOURNAL sheet.
  const jr = ss.getSheetByName('JOURNAL');
  if (jr && jr.getLastRow() <= 1) {
    L('delete sheet JOURNAL (empty)');
    if (!DRY_RUN) ss.deleteSheet(jr);
  }

  // 7. Clear redundant-initiative residuals (Kaggle overnight, duplicate Worker
  //    tasks, superseded four-layer migration). n8n infra only if RETIRE_N8N.
  const CANCEL = {
    'T023':           'Kaggle overnight — superseded by floyd-brief-worker',
    'T1776387071310': 'duplicate of T016 (photos Worker)',
    'T1776386526192': 'duplicate of T017 (calendar Worker)',
    'T1776387079597': 'duplicate of T015 (PWA deploy, already done)',
    'T1776385423295': 'four-layer migration audit — model superseded by Workers-forward'
  };
  if (RETIRE_N8N) {
    CANCEL['T1776384879086'] = 'n8n retired — orphan compose cleanup moot';
    CANCEL['T1776385179711'] = 'n8n retired — docker pin moot';
    CANCEL['T1776385845809'] = 'n8n retired — hooks subdomain not needed';
    CANCEL['T1776386480161'] = 'claude proxy Worker — not pursuing';
  }
  setTaskStatus(ss, CANCEL, 'cancelled', L);

  // 8. State key refresh.
  setKeyValue(ss, 'SYSTEM_STATE', 0, 1, 'focus_area',
    'Floyd 2.0 — sheet cleanup + Cloudflare Workers ingestion layer', L);
  setKeyValue(ss, 'SYSTEM_STATE', 0, 1, 'ARCHITECTURE_MODEL', 'v2_workers_forward', L);
  if (RETIRE_N8N) {
    ['N8N_PUBLIC_URL', 'N8N_TUNNEL_UUID', 'N8N_SCOPE'].forEach(function (k) {
      deleteRowsWhere(ss, 'SYSTEM_STATE', 0, function (v) { return v === k; }, L);
    });
  }

  // 9. Archive done/cancelled tasks -> TASKS_ARCHIVE (run AFTER step 7).
  archiveTasks(ss, L);

  L('=== cleanup ' + (DRY_RUN ? 'PREVIEW complete (no changes written)' : 'APPLIED') + ' ===');
  return log.join('\n');
}

// ── helpers ─────────────────────────────────────────────────────────────────
function deleteRowsWhere(ss, sheetName, col, pred, L) {
  const sh = ss.getSheetByName(sheetName);
  if (!sh) { L(sheetName + ': sheet not found'); return; }
  const data = sh.getDataRange().getValues();
  const hits = [];
  for (let i = 1; i < data.length; i++) {
    if (pred(String(data[i][col] || '').trim())) hits.push(i);
  }
  if (!hits.length) { L(sheetName + ': no rows match'); return; }
  L(sheetName + ': delete ' + hits.length + ' row(s) -> ' +
    hits.map(function (i) { return data[i][col]; }).join(', '));
  if (DRY_RUN) return;
  hits.sort(function (a, b) { return b - a; }).forEach(function (i) { sh.deleteRow(i + 1); });
}

function setKeyValue(ss, sheetName, keyCol, valCol, key, val, L) {
  const sh = ss.getSheetByName(sheetName);
  if (!sh) { L(sheetName + ': sheet not found'); return; }
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][keyCol]).trim() === key) {
      if (String(data[i][valCol]) === String(val)) { L(sheetName + ': ' + key + ' already current'); return; }
      L(sheetName + ': ' + key + ' = "' + data[i][valCol] + '" -> "' + val + '"');
      if (!DRY_RUN) sh.getRange(i + 1, valCol + 1).setValue(val);
      return;
    }
  }
  L(sheetName + ': key ' + key + ' not found');
}

function ensureLogRule(ss, tag, rowVals, L) {
  const sh = ss.getSheetByName('LOG_RULES');
  if (!sh) return;
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === tag) { L('LOG_RULES: ' + tag + ' already present'); return; }
  }
  L('LOG_RULES: add ' + tag);
  if (!DRY_RUN) sh.appendRow(rowVals);
}

function setTaskStatus(ss, map, newStatus, L) {
  const t = ss.getSheetByName('TASKS');
  if (!t) return;
  const data = t.getDataRange().getValues();
  const ID = 0, STATUS = 3, NOTES = 5;
  for (let i = 1; i < data.length; i++) {
    const id = String(data[i][ID]).trim();
    if (map[id]) {
      L('TASKS ' + id + ': "' + data[i][STATUS] + '" -> ' + newStatus + ' (' + map[id] + ')');
      if (!DRY_RUN) {
        t.getRange(i + 1, STATUS + 1).setValue(newStatus);
        const note = String(data[i][NOTES] || '');
        t.getRange(i + 1, NOTES + 1).setValue((note ? note + ' | ' : '') + 'cleanup 2026-06-14: ' + map[id]);
      }
    }
  }
}

function archiveTasks(ss, L) {
  const t = ss.getSheetByName('TASKS');
  if (!t) return;
  const data = t.getDataRange().getValues();
  const STATUS = 3;
  const move = [];
  for (let i = 1; i < data.length; i++) {
    const st = String(data[i][STATUS] || '').toLowerCase();
    if (st === 'complete' || st === 'completed' || st === 'cancelled') move.push(i);
  }
  if (!move.length) { L('archiveTasks: nothing to archive'); return; }
  L('archiveTasks: move ' + move.length + ' done/cancelled task(s) -> TASKS_ARCHIVE');
  if (DRY_RUN) return;
  let arch = ss.getSheetByName('TASKS_ARCHIVE');
  if (!arch) { arch = ss.insertSheet('TASKS_ARCHIVE'); arch.appendRow(data[0]); }
  move.forEach(function (i) { arch.appendRow(data[i]); });
  move.sort(function (a, b) { return b - a; }).forEach(function (i) { t.deleteRow(i + 1); });
}