# floyd-checkin — action bridge (slice 1)

Lets Floyd act on your phone via the Join API: notifications, check-in pings
that open the PWA modal, and alarms (via Tasker). This is the foundation the
check-in brain and modal will build on.

## Actions
| type | what it does | needs Tasker? |
|---|---|---|
| `notify` | Join notification (title + text) | no |
| `checkin` | Join notification that opens `checkin.html` on tap | no |
| `alarm` | push a `floyd=alarm;...` command Tasker turns into a real alarm | **yes** |
| `spanish` | daily Spanish nudge — Join push whose tap opens the `/spanish` link hub | no |

### Spanish coach (daily)
The hourly cron also runs `maybeSpanishNudge`: once each morning (≥8am
America/Toronto, throttled once per local day via `last_spanish_nudge`) it pushes
a notification — *"🇲🇽 Spanish — día N · Floor: 20 min Dreaming Spanish…"* — whose
`url` opens `GET /spanish`, a phase-aware hub of the day's learning links
(Dreaming Spanish, Language Transfer, Anki, iTalki/Preply). Phases compute from
the date (start Jun 21 2026 → goal Dec 21 2026) in `spanishPlan()`. Manual fire:
`/?key=<FLOYD_TOKEN>&type=spanish` (respects gates) or `&force=1` (ignores them).
Hub URL pinned via the `SELF_URL` var.

## Setup

### 1. Get your Join credentials
- Open the **Join** app → **Settings → Join API** (or go to the Join web app →
  the **API** section). Copy:
  - **API key** (`JOIN_API_KEY`)
  - **Device ID** of your phone (`JOIN_DEVICE_ID`) — listed next to the device.

### 2. Deploy the Worker
```bash
cd floyd-checkin
wrangler secret put JOIN_API_KEY      # paste the Join API key
wrangler secret put JOIN_DEVICE_ID    # paste your phone's device id
wrangler secret put FLOYD_TOKEN       # paste: floyd_vbM_H7kKkudmIkCziOO40dDmodxCv2Xe
wrangler deploy
```

### 3. Test (no Tasker needed for these two)
```bash
# Notification:
curl "https://floyd-checkin.<sub>.workers.dev/?key=<FLOYD_TOKEN>&type=notify&title=Floyd&text=Bridge%20works"

# Check-in ping (opens checkin.html when tapped — page comes in slice 2):
curl "https://floyd-checkin.<sub>.workers.dev/?key=<FLOYD_TOKEN>&type=checkin&msg=How%20is%20your%20energy%3F"
```
Both should pop a notification on your phone within a second or two.

### 4. Alarm → Tasker profile (one-time)
Alarms need Tasker because Join can't set one itself. The Worker sends a push
whose **text** is `floyd=alarm;time=HH:MM;label=...`. Create a Tasker profile to
catch it:

1. **Profile → Event → Plugin → Join → (push received)** — the event exposes the
   push text (e.g. `%jtext` / `%jmessage`, depending on your Join plugin version).
2. Add a **Task**:
   - **If** push text `~ floyd=alarm*`  (matches)
   - **Variable Split** the text on `;` → gives `%text1=floyd=alarm`, `%text2=time=HH:MM`, `%text3=label=...`
   - **Variable Split** `%text2` on `=` → `%text22` = the time; split again on `:` for hour/min.
   - **Set Alarm** — either Tasker's native *Set Alarm* action, or **Send Intent**:
     - Action: `android.intent.action.SET_ALARM`
     - Extra: `android.intent.extra.alarm.HOUR:<hour>`
     - Extra: `android.intent.extra.alarm.MINUTES:<min>`
     - Extra: `android.intent.extra.alarm.MESSAGE:<label>`
     - Extra: `android.intent.extra.alarm.SKIP_UI:true`

Then test:
```bash
curl "https://floyd-checkin.<sub>.workers.dev/?key=<FLOYD_TOKEN>&type=alarm&time=14:30&label=Reactine"
```

> The exact Join-plugin event name and variable (`%jtext` vs `%jmessage`) vary by
> version — tell me what your Tasker shows and I'll pin the steps. We can also
> extend the same profile to handle `floyd=notify`, `floyd=tts`, etc.

## Secrets note
`JOIN_API_KEY`, `JOIN_DEVICE_ID`, `FLOYD_TOKEN` live in Cloudflare's secret store
(`wrangler secret put`), never in the repo.
