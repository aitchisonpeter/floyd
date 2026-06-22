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

  entries.forEach((entry, i) => {
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

      switch (promoteTo) {
        case 'task':
          promoteToTask(ss, config, now, logKey, value, notes, context);
          break;
        case 'calendar':
          promoteToCalendar(ss, config, now, logKey, value, notes);
          break;
        case 'log':
          break;
        case 'system_state':
        default:
          writeStateKey(stateSheet, logKey, value, now, 'promotion');
          break;
      }

      logSheet.getRange(i + 1, 10).setValue('promoted');
      break;
    }
  });
}

function promoteToTask(ss, config, now, title, value, notes, context) {
  const tasksSheet = ss.getSheetByName('TASKS');
  if (!tasksSheet) return;

  const ownerBday = config['owner_birthday'] || '1981-01-01';
  const daysAlive = Math.floor((now - new Date(ownerBday)) / 86400000);
  const id        = 'T' + now.getTime();

  tasksSheet.appendRow([
    id,
    title + (value ? ': ' + value : ''),
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

    if (item.maxRows && rows.length > item.maxRows) rows = rows.slice(-item.maxRows);

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

  const calAlerts = buildCalendarAlerts(ss, daysAlive);
  if (calAlerts.length > 0) context['calendar_alerts'] = calAlerts;
  
  const pc = computePartnerCycle(ss, config);
  if (pc) { context['partner_cycle_live'] = pc; syncPartnerCycleToState(ss, pc); }

  const presence = computePartnerPresence(ss, config);
  if (presence) { context['partner_presence'] = presence; syncPresenceToState(ss, presence); }
  context._meta = {
    generated:    now.toISOString(),
    days_alive:   daysAlive,
    owner_name:   config['owner_name']   || '',
    owner_id:     config['owner_id']     || '',
    partner_name: config['partner_name'] || '',
    partner_id:   config['partner_id']   || '',
    version:      '3.4'
  };

  return context;
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
      upsert(
        safeId(ev, 'gcal_'),
        dateOnly(ev.getStartTime()),
        ev.getTitle() || 'event',
        { tag: '#calendar', source: 'gcal', gcal_id: ev.getId(),
          notify_days_before: 7, location: ev.getLocation() || '', all_day: ev.isAllDayEvent() }
      );
      appts++;
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

  if (rule.action === 'delete') {
    for (let i = data.length - 1; i >= 1; i--) {
      if (data[i][4] === tag) logSheet.deleteRow(i + 1);
    }
    return;
  }

  if (rule.action === 'replace' || rule.max_entries !== null) {
    const keep    = rule.max_entries !== null ? rule.max_entries : 1;
    const tagRows = [];
    for (let i = 1; i < data.length; i++) { if (data[i][4] === tag) tagRows.push(i); }
    const toDelete = tagRows.slice(0, Math.max(0, tagRows.length - keep));
    for (let i = toDelete.length - 1; i >= 0; i--) logSheet.deleteRow(toDelete[i] + 1);
  }
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
  pushFloydMode(config, currentContext, 1800);  // keep Pi presence cache fresh

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