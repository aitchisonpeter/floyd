#!/usr/bin/env bash
# Deploy the Floyd PWA front-end to Cloudflare Pages (direct-upload project `floyd`).
#
# Single source of truth = the repo ROOT. `public/` is the generated upload
# artifact (gitignored) — never hand-edit it. This script syncs the canonical
# front-end files from root into public/ and ships, replacing the old, drift-prone
# manual `cp index.html public/ && wrangler pages deploy ...` ritual.
#
# Usage:  ./scripts/deploy-pages.sh           # sync + deploy
#         ./scripts/deploy-pages.sh --dry-run # sync only, show what would deploy
set -euo pipefail
cd "$(dirname "$0")/.."

# Canonical files served by the PWA. config.js carries the token (gitignored at
# both root and public/) — copied locally, never committed.
FILES=(
  index.html
  context.html
  checkin.html
  explorer.html
  config.js
  manifest.json
  bdv_icon.png
  travel.png
  travel.webp
  tuliptown.webp
)

mkdir -p public
missing=0
for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "  MISSING at root: $f" >&2
    missing=1
    continue
  fi
  cp "$f" "public/$f"
  echo "  synced $f"
done
[[ "$missing" == 1 ]] && { echo "Aborting: a canonical file is missing at root." >&2; exit 1; }

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "Dry run — public/ synced, not deploying."
  exit 0
fi

echo "Deploying public/ to Cloudflare Pages (project floyd, branch main)…"
wrangler pages deploy public --project-name floyd --branch main
