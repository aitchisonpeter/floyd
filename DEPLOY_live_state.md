# Make SYSTEM_STATE a live mirror

Three deterministic changes so state follows your logs and never drifts.
(The interpretive nightly brief — focus_today/floyd_brief/intentions — is the
separate scheduled Claude agent.)

---

## Pillar 1 — Reverse promotion (logs update state)

`PROMOTION_RULES` already maps state keys to tags. Today the bridge only runs
state→log. This adds log→state: when an entry is imported, if its tag maps to a
state key, the value is written there. So `#project "rebuilding van electrics"`
updates `active_project` automatically.

**Add this function:**

```javascript
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
```

**Wire it** in `handleImport`, right after `applyLogRules(ss, entry.tag || '#note');`:

```javascript
    promoteEntryToState(ss, entry, config, now);
```

> Safe by design: only fires for rules with a blank `Promote_To` (the state keys),
> and `writeStateKey` upserts, so repeats are harmless. Calendar/task rules are
> untouched.

---

## Pillar 1b — Let a voice note count as project talk

Reverse promotion needs the entry tagged `#project`. Add rows to `TAG_KEYWORDS`
so the smart-tagger recognizes project/van talk (columns: `tag | keywords | priority`):

| tag | keywords | priority |
|---|---|---|
| `#project` | working on, project, building, launching, shipped, deploying | 2 |
| `#van` | van, odometer, maintenance, oil change, tires, engine | 2 |

Now "I'm working on the website" → tagged `#project` → promoted to `active_project`.
Tune keywords if they over-trigger; ties fall back to `#note`.

---

## Pillar 2 — Compute derived values on read (drift-proof)

In `getSystemData`, add before `return state;`. These recompute every read so they
can't go stale.

```javascript
  // current_mode mirrors the GPS-derived mode (no separate stale copy)
  state['current_mode'] = state['system_mode'];

  // energy_baseline = 7-day rolling average of #energy ratings
  (function () {
    const bday = config['owner_birthday'] || '1981-01-01';
    const today = Math.floor((new Date() - new Date(bday)) / 86400000);
    const log = ss.getSheetByName('PERSONAL_LOG').getDataRange().getValues();
    let sum = 0, n = 0;
    for (let i = log.length - 1; i >= 1; i--) {
      if (parseInt(log[i][0]) < today - 7) break;       // col A = days_alive
      if (log[i][4] === '#energy') {                    // col E = tag
        const m = String(log[i][5]).match(/(\d+(\.\d+)?)/);  // col F = value
        if (m) { sum += parseFloat(m[1]); n++; }
      }
    }
    if (n > 0) state['energy_baseline'] = (sum / n).toFixed(1) + '/10';
  })();
```

(Optional daily resets: if you want `spent_today` / `notifications_today` to show 0
at the start of each day rather than carry yesterday's total until the next event,
say so and I'll add a date-stamp check — minor add.)

---

## Pillar 3 — Retire dead flags

Delete these rows from `SYSTEM_STATE` (no longer meaningful):
- `PWA_HOST` = "pending_migration_to_cloudflare_pages" (migration done)
- `calendar_stale_may12_return` = "cleared"

---

## Deploy & verify
Deploy a new web-app version. Then:
- Log `#project "test — building the dashboard"` → `GET ?type=dashboard` shows
  `active_project` = that text.
- `energy_baseline` shows an `N/10` average instead of "pending".
- `current_mode` matches `system_mode`.

## Undo
Remove the added blocks / keyword rows and redeploy a prior version.
```
