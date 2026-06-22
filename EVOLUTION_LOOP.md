# FLOYD Evolution Loop — execution spec

**The dream, made buildable:** accretion → nightly reflection → proposed sheet
mutation → (auto-apply low-risk | one-tap apply gated) → tomorrow's UX is
different. This turns Floyd from a mirror that *grows* into one that *evolves*.

Status (2026-06-22): foundation is in place (sheet-as-truth, authenticated
gateway + idempotency, capped-surfacing north star, working coach
propose→activate). The evolution *engine* below is **not built yet** — this doc
is the spec to build it. The plumbing came first on purpose: you cannot let a
system rewrite its own sheets over an unauthenticated/non-idempotent write path.

---

## 1. `PROPOSALS` sheet (new tab)

One row = one proposed mutation. Mirrors the CALENDAR/PROJECTS meta-JSON convention.

| col | field    | notes |
|-----|----------|-------|
| 1   | id       | `P<epoch_ms>` |
| 2   | created  | ISO |
| 3   | source   | `reflection` \| `chat` \| `friction` |
| 4   | type     | the op (see §2 whitelist) |
| 5   | summary  | one human line ("add a #fuel tag for gas fill-ups") |
| 6   | packet   | JSON — the mutation itself (§2) |
| 7   | risk     | `auto` \| `tap` |
| 8   | status   | `proposed` \| `approved` \| `applied` \| `rejected` \| `expired` |
| 9   | applied  | ISO |
| 10  | result   | executor echo / error string |

EVOLUTION_LOG stays as the free-text "Floyd had an idea" stream; PROPOSALS is the
*structured, applyable* subset. A chat `floyd_propose` that names a concrete op
writes a PROPOSALS row; vague ideas stay in EVOLUTION_LOG.

---

## 2. Mutation packet schema — the JSON the dream is about

A packet is `{op, ...args}`. **Whitelist only** — the executor refuses any op not
listed. Each op maps to an *existing proven write path* (no new write surface):

```
add_tag      {op:"add_tag", tag:"#fuel", keywords:["gas","fill up","fuel"], retention:"keep"}
               → append LOG_RULES row + TAG_KEYWORDS rows (sheet_update)
add_card     {op:"add_card", key, title, source_key, format}
               → DISPLAY_CONFIG row (sheet_update)
track_metric {op:"track_metric", key:"water_level", seed:"", card:{...}}
               → SYSTEM_STATE seed (state write) + optional add_card
retire_flag  {op:"retire_flag", key:"some_state_key"}
               → SYSTEM_STATE value → "retired" (API can't DELETE rows, only mark)
propose_coach{op:"propose_coach", key, meta:{...phases,floor,links}}
               → PROJECTS row status=proposed (REUSES the existing /activate flow)
set_config   {op:"set_config", key, value}
               → CONFIG row (sheet_update) — ALWAYS tap, NEVER auto
```

The executor is a **whitelist dispatcher, not an eval** — Floyd can only compose
pre-approved verbs. New op = a code change + review, deliberately.

---

## 3. Risk policy — auto vs tap

- **auto** (Floyd applies itself, then logs it): `add_tag`, `retire_flag`,
  `add_card` for an already-tracked source_key, `propose_coach` (proposing is
  itself low-risk — activation is still a tap).
- **tap** (needs Peter's one tap): `set_config`, `track_metric` (new surface
  area / new card), anything new it's unsure about.
- **HARD never-auto blocklist** (refused by the executor even if mislabeled auto):
  any op touching protected tags `#balance` / `#odometer` / `#cycle_*`, any
  CONFIG/secret key, any `set_config`. These are the corruption-class + security
  surfaces. No row deletes, ever.

---

## 4. Reflection cron — the missing heartbeat

New Worker `floyd-reflect/` (or a second cron on floyd-brief-worker).

- **cron:** nightly, ~1h after floyd-brief (e.g. `0 11 * * *` UTC / 7am ET).
- **reads:** context (logs last ~50, current_state, open friction counters at/over
  threshold, open PROPOSALS for dedupe).
- **one model call** (sonnet for cost; opus if quality lags), structured output,
  the §2 whitelist handed in as the tool/JSON schema. Output: **0–2** packets,
  each `{type, summary, packet, risk}`.
- **caps (capped-surfacing north star):** ≤2 proposals/day; dedupe against open
  PROPOSALS (never re-propose the same op+target); **bias to silence** — emit
  nothing on a day that doesn't earn it.
- **writes** each packet to PROPOSALS (`status=proposed`). For `risk=auto` AND not
  on the never-auto blocklist → call the executor immediately, set `status=applied`.

---

## 5. Apply executor — the missing "apply half"

Apps Script function `applyProposal(id)` + new gateway-gated route `apply_proposal {id}`.

- loads the PROPOSALS row; validates `op ∈ whitelist`; re-checks the never-auto
  blocklist; performs the mutation via the **same internal write helpers**
  (handleSheetWrite / state write) — same authenticated, idempotent path.
- **idempotent:** if `status==applied`, no-op (safe to retry; matches the gateway
  idempotency story).
- writes `status=applied`, `applied`, `result`; on error → `result=<error>`,
  status unchanged (so it can be retried/inspected).

---

## 6. Surface — close the loop where Peter sees it

- **floyd-brief** adds, when open `tap` proposals exist, one line:
  `🌱 Floyd proposes: <summary> — tap to apply`, linking to a `/proposals` hub
  (same pattern as the coach `/hub`) with per-proposal apply/reject buttons.
- **auto-applied** mutations get a quiet brief note: `🔧 Floyd adjusted: <summary>`
  — transparency is non-negotiable; the mirror always tells you what it changed.

---

## 7. Build order (next session — straight execution)

1. Create `PROPOSALS` sheet (clasp one-shot or manual; see also the unbuilt
   maintenance-runner friction `friction_clasp_maint`).
2. Apps Script: `applyProposal` + `apply_proposal` route + op whitelist + guards.
   Push + deploy (in-place on the live deployment id, keeps /exec stable).
   **Unit-test each op via the gateway with a throwaway packet** before wiring AI.
3. `floyd-reflect` Worker: reflection call → write proposals **with auto-apply OFF**.
   Deploy. Watch a few days of proposals for sanity.
4. Flip auto-apply ON for the safe ops once proposals read trustworthy.
5. Brief surfacing line + `/proposals` hub.

---

## Safety invariants (why the plumbing came first)

- Every mutation goes through the existing **authenticated gateway + idempotency**.
- Executor is a **whitelist, not an eval** — composed verbs only.
- **Protected tags** (#balance/#odometer/#cycle_*) and **secret/CONFIG keys** are
  never auto-mutated; **no row deletes** ever.
- **Bias to silence:** ≤2/day, dedupe, skip when nothing earns it.
- **Transparency:** every applied mutation is echoed back into the morning brief.
