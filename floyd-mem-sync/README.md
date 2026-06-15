# floyd-mem-sync

Keeps the assistant's local memory (`~/.claude/.../memory/*.md`) and the Floyd
**`AI_MEMORY`** sheet tab in sync. **The sheet is canonical** — the local files
are a disposable cache you can rebuild with `pull`. This is the sovereignty
layer: swap the LLM, point it at `AI_MEMORY`, inherit everything. No model owns
Floyd's memory.

Everything flows through the existing `sheet_update` (write) and `memory_read`
(read) routes on the Apps Script door — no special access, no third-party
service.

## Use
```bash
cp .env.example .env   # fill in FLOYD_API_URL, FLOYD_API_SECRET, MEMORY_DIR
node sync.mjs status   # compare both sides, no writes
node sync.mjs push     # local memory/*.md -> AI_MEMORY (upsert by name)
node sync.mjs pull     # AI_MEMORY -> local memory/*.md
```

## Columns
`name | description | type | body | links | updated | source`

`MEMORY.md` (the index) is intentionally skipped — it's derived, not a memory.
