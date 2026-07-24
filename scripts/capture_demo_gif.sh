#!/usr/bin/env bash
# capture_demo_gif.sh — one command to (re-)record the launch demo GIF.
#
# Bootstraps Playwright, drives the first-run continuity product tour headlessly
# (scripts/capture_demo_gif.mjs), then converts the recording to an optimised
# GIF at dashboard/public/continuity-demo.gif — the proof artifact the /welcome
# landing page slots in (GO_LIVE_PLAN §5 proof artifact #1, see CONTINUITY_DEMO.md).
#
# The dashboard must be running and reachable first:
#   myai up            # gateway + dashboard + mongo on localhost
#   myai demo          # (optional) seed the demo dataset for richer background
#   ./scripts/capture_demo_gif.sh
#
# Options:
#   --url URL     dashboard base URL           (default: http://localhost:3210)
#   --out PATH    final GIF path               (default: dashboard/public/continuity-demo.gif)
#   --keep        keep the intermediate frames + webm under dashboard/public/demo
#
# GIF conversion prefers ffmpeg (palettegen for clean colour), then gifski.
# With neither installed the webm + PNG filmstrip are left in place and the
# script exits 0 with a note — the capture still succeeded.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
URL="${DASHBOARD_URL:-http://localhost:3210}"
OUT_GIF="$ROOT/dashboard/public/continuity-demo.gif"
WORK="$ROOT/dashboard/public/demo"
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --out) OUT_GIF="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

echo "▶ demo-GIF capture"
echo "  dashboard : $URL"
echo "  output    : $OUT_GIF"

# --- 1. reachability ---------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  if ! curl -sf -o /dev/null --max-time 5 "$URL"; then
    echo "  ✗ $URL not reachable — start the stack first (myai up), then re-run." >&2
    exit 1
  fi
fi

# --- 2. Playwright bootstrap -------------------------------------------------
# Prefer a project-local playwright; else fetch on demand with npx.
RUNNER=(node)
if [ -x "$ROOT/dashboard/node_modules/.bin/playwright" ] || [ -d "$ROOT/dashboard/node_modules/playwright" ]; then
  export NODE_PATH="$ROOT/dashboard/node_modules"
else
  echo "  · playwright not vendored — using npx (first run downloads it)"
  # Ensure the browser binary exists (idempotent, cached).
  npx --yes playwright install chromium >/dev/null 2>&1 || true
fi

# --- 3. drive the tour -------------------------------------------------------
echo "  · driving the product tour…"
DASHBOARD_URL="$URL" node "$HERE/capture_demo_gif.mjs" --out "$WORK"
CAP=$?
if [ "$CAP" -ne 0 ]; then
  echo "  ✗ capture step failed (exit $CAP)" >&2
  exit "$CAP"
fi

WEBM="$WORK/tour.webm"

# --- 4. webm → GIF -----------------------------------------------------------
if [ ! -f "$WEBM" ]; then
  echo "  ! no video recorded; PNG filmstrip is in $WORK — cannot assemble GIF here."
  exit 0
fi

if command -v ffmpeg >/dev/null 2>&1; then
  echo "  · ffmpeg → optimised GIF"
  PAL="$WORK/palette.png"
  FILTERS="fps=12,scale=900:-1:flags=lanczos"
  ffmpeg -y -i "$WEBM" -vf "$FILTERS,palettegen=stats_mode=diff" "$PAL" >/dev/null 2>&1
  ffmpeg -y -i "$WEBM" -i "$PAL" -lavfi "$FILTERS,paletteuse=dither=bayer:bayer_scale=3" "$OUT_GIF" >/dev/null 2>&1
  rm -f "$PAL"
elif command -v gifski >/dev/null 2>&1; then
  echo "  · gifski → GIF"
  gifski --fps 12 --width 900 -o "$OUT_GIF" "$WEBM" >/dev/null 2>&1
else
  echo "  ! neither ffmpeg nor gifski installed — leaving $WEBM + frames in $WORK"
  echo "    install one, then: ffmpeg -i $WEBM $OUT_GIF"
  exit 0
fi

if [ -f "$OUT_GIF" ]; then
  SIZE=$(du -h "$OUT_GIF" | cut -f1)
  echo "  ✓ GIF written: $OUT_GIF ($SIZE)"
  echo "    swap the /welcome demo placeholder for <img src=\"/continuity-demo.gif\" …>"
else
  echo "  ✗ GIF conversion produced no output" >&2
  exit 1
fi

# --- 5. cleanup --------------------------------------------------------------
if [ "$KEEP" -eq 0 ]; then
  rm -rf "$WORK"
else
  echo "  · kept intermediates in $WORK"
fi
