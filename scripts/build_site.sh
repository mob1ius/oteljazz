#!/usr/bin/env bash
#
# Assemble dist/ for oteljazz.com from an EXPLICIT ALLOWLIST.
#
# Why an allowlist and not a copy of web/: the repo holds ~430MB that must never ship, including
# corpus_raw/wjazzd.db (the raw Weimar Jazz Database, ODbL-encumbered), the Logic project, and the
# whole Python engine. ROADMAP 4.7's standing instruction is that a naive directory copy or a host
# with directory listing enabled would expose exactly that. Listing files by hand here means a new
# file has to be added deliberately to become public, rather than becoming public by default.
#
# Cloudflare Pages config:
#   Build command:            bash scripts/build_site.sh
#   Build output directory:   dist
#
# Usage: bash scripts/build_site.sh   (from the repo root)

set -euo pipefail

cd "$(dirname "$0")/.."
SRC="web"
OUT="dist"

# Everything the shipped page actually loads, derived from the code rather than from docs:
#   grep -n "fetch(\|src=\|url(\|import " web/demo.html web/app.js web/director.js web/engine.js
# Deliberately NOT shipped:
#   hero.html            -- README image source. A frozen, static-looking frame at a public URL
#                           invites "is this demo even real?", which is the opposite of the point.
#   otel_trace_demo.json -- deleted; nothing fetched it (see docs/README.md).
FILES=(
  "demo.html"                 # copied to index.html below
  "app.js"
  "director.js"
  "engine.js"
  "corpus_model_jazz.json"
  "_headers"
  "robots.txt"                # crawler policy; also the thing the crawler log is measuring
  "ai.txt"
  "favicon.png"               # without this every browser visit 404s and logs a noise row
  "og.jpg"                    # social card; a real screenshot of the demo, not a mockup
)
DIRS=(
  "assets"                    # radio_overlay.png
  "samples"                   # salamander_piano/, pizz_bass/
  "vendor"                    # Tone.js (vendored, verified against the CDN's SRI hash)
)

rm -rf "$OUT"
mkdir -p "$OUT"

for f in "${FILES[@]}"; do
  [[ -f "$SRC/$f" ]] || { echo "FATAL: missing $SRC/$f" >&2; exit 1; }
  cp "$SRC/$f" "$OUT/$f"
done

for d in "${DIRS[@]}"; do
  [[ -d "$SRC/$d" ]] || { echo "FATAL: missing $SRC/$d" >&2; exit 1; }
  cp -R "$SRC/$d" "$OUT/$d"
done

# Serve the demo at the domain root.
mv "$OUT/demo.html" "$OUT/index.html"

# Guard rail, not decoration: if any of these ever appear in dist/ the allowlist has been edited
# carelessly, and it is much better to fail the build than to publish a licensing-encumbered
# database or the engine source.
if find "$OUT" \( -name '*.py' -o -name '*.db' -o -name '*.pyc' -o -name '.env' \) -print -quit | grep -q .; then
  echo "FATAL: forbidden file type found in $OUT -- refusing to publish" >&2
  find "$OUT" \( -name '*.py' -o -name '*.db' -o -name '*.pyc' -o -name '.env' \) >&2
  exit 1
fi

echo "built $OUT/ ($(du -sh "$OUT" | cut -f1))"
find "$OUT" -type f | sort | sed "s|^$OUT/|  |"
