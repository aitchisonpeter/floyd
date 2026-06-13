# floyd-mcp

An MCP server that exposes your Floyd store to Claude (Desktop, Code, or any MCP
client) as three tools. The Floyd Google Sheet stays the source of truth — Claude
just reads and writes through it. The write token lives in this process's
environment, never in the model's context.

## Tools

| Tool | Reads/Writes | What it does |
|---|---|---|
| `floyd_read_context` | read | The full context packet (state, tasks, log, calendar, …). Pass `sections` to narrow it. |
| `floyd_query_log` | read | Recent `PERSONAL_LOG` entries, filterable by `person` / `tag`. |
| `floyd_append_entries` | **write** | Append atomic entries (`tag` + `value`, …). Modifies the live store. |

## Setup

```bash
cd floyd-mcp
npm install
cp .env.example .env   # then fill in FLOYD_API_URL and FLOYD_API_SECRET
node smoke.js          # optional: verify reads + write-gate (writes nothing)
```

`FLOYD_API_URL` and `FLOYD_API_SECRET` are the same two values in your root
`config.js` (`api_url` and `api_secret`).

## Wire it into Claude

**Claude Code** (from this folder):

```bash
claude mcp add floyd \
  --env FLOYD_API_URL="https://script.google.com/macros/s/YOUR_ID/exec" \
  --env FLOYD_API_SECRET="your_secret" \
  -- node "/Users/aitchison/FLOYD 2.0/May 27 stack/floyd-main 5/floyd-mcp/index.js"
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "floyd": {
      "command": "node",
      "args": ["/Users/aitchison/FLOYD 2.0/May 27 stack/floyd-main 5/floyd-mcp/index.js"],
      "env": {
        "FLOYD_API_URL": "https://script.google.com/macros/s/YOUR_ID/exec",
        "FLOYD_API_SECRET": "your_secret"
      }
    }
  }
}
```

Restart the client, then ask Claude things like *"what's my current Floyd state?"*
or *"log a #mood entry: 7/10 calm."* Claude will confirm before writing.

## Notes / limits

- `floyd_query_log` filters the most recent ~50 entries (the context route's cap).
  A deeper history search would need a dedicated `sheet_read` route on PERSONAL_LOG.
- Apps Script has per-day quotas and ~1–3s latency per call — fine for personal use.
- The token is visible to anything that can read this server's env; keep `.env` private
  (it's gitignored).
