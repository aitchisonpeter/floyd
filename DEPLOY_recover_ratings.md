# Recover date-coerced ratings (#mood / #energy / #sleep)

Google Sheets turned bare `N/10` rating values into dates (`8/10` → "Aug 10"),
because the Value column wasn't plain-text. The damage is reversible: the **month
encodes the rating** and the day is always `10` (the `/10`). So `2026-08-10` was
`8/10`, `2026-07-10` was `7/10`, etc.

This one function:
1. sets the Value column (`F`) to plain text so it can never happen again, and
2. rewrites every date-coerced `#mood`/`#energy`/`#sleep` value back to `M/10`.

It also fixes the two rows logged today. (You do **not** need to run the separate
`fixLogValueFormat` — this includes it.)

## Run it

Paste into the Apps Script editor and Run. **`DRY_RUN` is `true` by default** —
it changes nothing and just logs what it *would* do. Review the log (View →
Logs), then set `DRY_RUN = false` and Run again to apply.

```javascript
function recoverCoercedRatings() {
  const DRY_RUN = true;                       // ← set to false to actually write
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
```

## Verify
After the real run, the previously date-valued rows read as `8/10`, `7/10`, etc.,
and new bare `N/10` logs stay text. Re-run with `DRY_RUN = true` — it should
report `0`.

## Note on today's rows
This recovers the two `#mood`/`#energy` rows I logged this morning back to `8/10`.
I also re-logged them as `8/10 good`, so you'll have a slight duplicate for today —
delete the `8/10 good` pair from the dashboard if you want it tidy, or leave them.

## Undo
Only the matched rating cells change. Your `File → Make a copy` snapshot (or the
git baseline) restores everything if needed.
```
