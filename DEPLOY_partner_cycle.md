# Keep partner-cycle data live (compute-on-read)

`PARTNER_STATE` was frozen at April values because nothing recomputes it. This
derives the cycle day / phase / countdown on every read from the last logged
`#cycle_start` + `average_cycle_length` + today, using `PARTNER_CYCLE` for the
phase label. Nothing to go stale; the "New Cycle" button re-anchors it for free.

## 1. Add the compute function

Paste into the Apps Script editor:

```javascript
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
```

## 2. Wire it into the dashboard — in `getSystemData`, before `return state;`

```javascript
  const pc = computePartnerCycle(ss, config);
  if (pc) {
    state['partner_cycle_phase']     = pc.current_phase;
    state['partner_cycle_day']       = pc.current_cycle_day;
    state['partner_days_until_next'] = pc.days_until_next;
  }
```

## 3. Wire it into context — in `handleContextBuild`, before `context._meta = {...}`

```javascript
  const pc = computePartnerCycle(ss, config);
  if (pc) context['partner_cycle_live'] = pc;
```

Deploy a **new version** of the web app. No config/URL change.

## 4. (Optional) keep the PARTNER_STATE cells fresh too

Only needed if you read the sheet directly. Add a daily time-driven trigger
(Triggers → Add Trigger → `refreshPartnerState` → Day timer):

```javascript
function refreshPartnerState() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const pc = computePartnerCycle(ss, loadConfig(ss));
  if (!pc) return;
  const sh = ss.getSheetByName('PARTNER_STATE');
  const data = sh.getDataRange().getValues();
  const map = { current_cycle_start: pc.current_cycle_start, current_cycle_day: pc.current_cycle_day,
                predicted_next_start: pc.predicted_next_start, days_until_next: pc.days_until_next,
                current_phase: pc.current_phase };
  for (let i = 1; i < data.length; i++) {
    if (map[data[i][1]] !== undefined) {
      sh.getRange(i + 1, 3).setValue(map[data[i][1]]);
      sh.getRange(i + 1, 8).setValue(new Date());     // updated col
    }
  }
}
```

## Verify
`GET <api_url>?type=dashboard` → `partner_cycle_phase` / `partner_days_until_next`
now reflect today (not "Do Not Disturb / 23"). Tap **New Cycle** → values reset to
day 1 and recompute from that date forward.

## Undo
Remove the added blocks and redeploy, or roll back to a prior deployment version.
```
