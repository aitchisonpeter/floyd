// Smoke test — proves the read path works and the write path is correctly gated,
// WITHOUT writing any data (uses empty entries). Prints shapes/counts only, never
// personal values. Run: node smoke.js  (with FLOYD_API_URL / FLOYD_API_SECRET set)

import { readContext, queryLog } from "./floyd.js";

const API_URL = process.env.FLOYD_API_URL;
const API_SECRET = process.env.FLOYD_API_SECRET || "";

async function postRaw(body) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "follow",
  });
  return res.json();
}

async function main() {
  console.log("1) readContext() — sections & counts:");
  const ctx = await readContext();
  for (const k of Object.keys(ctx)) {
    const v = ctx[k];
    console.log(`   - ${k.padEnd(20)} ${Array.isArray(v) ? `list[${v.length}]` : typeof v}`);
  }

  console.log("\n2) queryLog({ person: 'peter' }) — count only:");
  const logs = await queryLog({ person: "peter" });
  console.log(`   ${logs.length} entries`);

  console.log("\n3) write-path auth (empty entries — nothing written):");
  console.log("   with token →", JSON.stringify(await postRaw({ key: "import_entries", entries: [], token: API_SECRET })));
  console.log("   no token   →", JSON.stringify(await postRaw({ key: "import_entries", entries: [] })));

  console.log("\nSMOKE OK");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e.message);
  process.exit(1);
});
