# Data hygiene — one-off cleanup

Runs against the **live** Google Sheet (the bloat is there, not in the local
snapshot). Each function archives before it trims — nothing is hard-deleted without
a copy. Run from the Apps Script editor (select the function → Run).

> Take a copy of the sheet first (File → Make a copy) as a belt-and-braces restore
> point, then run.

## 1. Archive accumulated AI_SESSIONS (~13.6k rows)

Most of these are sessions logging Floyd's own construction, not life data. This
copies the full history to `AI_SESSIONS_ARCHIVE` and keeps the most recent `KEEP`
rows live.

```javascript
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
```

## 2. Trim trailing blank rows (padded config sheets)

`PROMPTS`, `AI_TARGETS`, `LOG_RULES` etc. carry hundreds of empty grid rows past
their real content. Harmless to the API (empties are skipped) but they bloat the
file. This deletes blank trailing rows on a sheet.

```javascript
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
```

## Undo
- Archived sessions live in `AI_SESSIONS_ARCHIVE` — copy any back if needed.
- Trailing blanks carry no data; if you want the grid bigger again, Sheets adds rows
  automatically as you type, or Insert → Rows.
- The File-→-Make-a-copy snapshot restores everything.
