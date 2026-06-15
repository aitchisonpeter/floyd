// floyd-mem-sync — keeps the assistant's local memory and the Floyd AI_MEMORY
// sheet tab in sync, so the SHEET is canonical and any LLM can inherit it.
//
//   node sync.mjs push   # local memory/*.md  -> AI_MEMORY rows (upsert by name)
//   node sync.mjs pull   # AI_MEMORY rows      -> local memory/*.md
//   node sync.mjs status # show both sides, no writes
//
// Sovereignty note: the sheet is the source of truth. The local ~/.claude
// memory files are a disposable cache reconstructable via `pull`. Swap the LLM
// and point it at AI_MEMORY — nothing is lost.
//
// Config (env, never hardcode secrets):
//   FLOYD_API_URL     Apps Script /exec deployment URL
//   FLOYD_API_SECRET  shared write token (CONFIG.api_secret)
//   MEMORY_DIR        absolute path to the memory/ folder

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const API = process.env.FLOYD_API_URL;
const TOKEN = process.env.FLOYD_API_SECRET || "";
const MEMORY_DIR = process.env.MEMORY_DIR;
const SHEET = "AI_MEMORY";
const HEADERS = ["name", "description", "type", "body", "links", "updated", "source"];
const SKIP = new Set(["MEMORY.md"]); // the index is derived, not a memory

if (!API || !MEMORY_DIR) {
  console.error("Set FLOYD_API_URL and MEMORY_DIR (see .env.example).");
  process.exit(1);
}

const post = async (body) => {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, token: TOKEN }),
    redirect: "follow",
  });
  const j = await r.json();
  if (j && j.error) throw new Error("Floyd: " + j.error);
  return j;
};
const get = async (type) => {
  const r = await fetch(`${API}?type=${type}&t=${Date.now()}`, { redirect: "follow" });
  return r.json();
};

// --- tiny frontmatter parser (no deps) -------------------------------------
function parse(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { name: null, description: "", type: "reference", body: md.trim() };
  const fm = m[1], body = m[2].trim();
  const unquote = (s) => (s || "").trim().replace(/^["'](.*)["']$/, "$1");
  const field = (k) => unquote((fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m")) || [])[1]);
  // anchor to line-start so `node_type:` doesn't shadow `type:`
  const type = unquote((fm.match(/^\s*type:\s*(.+)$/m) || [])[1]) || "reference";
  const links = [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((x) => x[1]).join(", ");
  return { name: field("name"), description: field("description"), type, body, links };
}
function rebuild(row) {
  return `---\nname: ${row.name}\ndescription: ${row.description || ""}\nmetadata:\n  type: ${row.type || "reference"}\n---\n\n${row.body || ""}\n`;
}

async function localFiles() {
  const names = (await readdir(MEMORY_DIR)).filter((f) => f.endsWith(".md") && !SKIP.has(f));
  const out = [];
  for (const f of names) {
    const md = await readFile(join(MEMORY_DIR, f), "utf8");
    const p = parse(md);
    out.push({ file: f, name: p.name || f.replace(/\.md$/, ""), ...p });
  }
  return out;
}

async function push() {
  const files = await localFiles();
  const rows = files.map((p) => ({
    match_column: 1,
    match_value: p.name,
    values: { "1": p.name, "2": p.description, "3": p.type, "4": p.body, "5": p.links || "", "6": new Date().toISOString(), "7": "claude_code" },
  }));
  // ensure tab/headers exist, then upsert all
  const res = await post({ key: "sheet_update", sheet: SHEET, headers: HEADERS, rows });
  // retire the connectivity smoke row if present
  await post({ key: "sheet_update", sheet: SHEET, rows: [{ action: "delete", match_column: 1, match_value: "_smoke", values: {} }] }).catch(() => {});
  console.log(`push: ${files.length} memories -> ${SHEET} (updated ${res.updated}, appended ${res.appended})`);
}

async function pull() {
  const j = await get("memory_read");
  const rows = (j.rows || []).filter((r) => r.name && r.name !== "_smoke");
  const existing = new Set(await readdir(MEMORY_DIR));
  let written = 0, skipped = 0;
  for (const row of rows) {
    const fname = `${row.name}.md`;
    // non-destructive: never clobber a live harness-managed file (it carries
    // node_type/originSessionId we don't reproduce). Only reconstruct missing.
    if (existing.has(fname)) { skipped++; continue; }
    await writeFile(join(MEMORY_DIR, fname), rebuild(row), "utf8");
    written++;
  }
  console.log(`pull: ${written} reconstructed, ${skipped} already present (preserved) — ${SHEET} -> ${MEMORY_DIR}`);
}

async function status() {
  const [files, j] = [await localFiles(), await get("memory_read")];
  const remote = new Set((j.rows || []).map((r) => r.name));
  const local = new Set(files.map((f) => f.name));
  console.log(`local: ${local.size}   remote: ${remote.size}`);
  console.log("only local :", [...local].filter((n) => !remote.has(n)).join(", ") || "—");
  console.log("only remote:", [...remote].filter((n) => !local.has(n)).join(", ") || "—");
}

const cmd = process.argv[2] || "status";
({ push, pull, status })[cmd]?.() ?? (console.error("usage: node sync.mjs push|pull|status"), process.exit(1));
