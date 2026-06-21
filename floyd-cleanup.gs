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
const DRY_RUN        = true;   // ← set to false to actually apply changes
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
