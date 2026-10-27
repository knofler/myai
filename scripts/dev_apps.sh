#!/usr/bin/env bash
# dev_apps.sh — ONE file that opens the operator's dev apps ready to use on any
# Mac: Bruno with every api_management collection registered, and MongoDB Compass
# with the saved connections. Keyword-able (`dev apps`).
#
# Builds on what exists, reimplements nothing:
#   • Bruno   — api_management/scripts/setup_bruno.sh registers + trusts every
#               bruno/**/bruno.json collection; this script installs Bruno if
#               missing, runs that, then opens the app.
#   • Compass — Compass's own CLI: `--export-connections` (old Mac) and
#               `--import-connections` (new Mac). Exported WITHOUT a passphrase,
#               so Compass leaves every password out by design — you re-enter a
#               password once per connection on the new Mac. Fallback when no
#               export exists: credential-less Atlas connections built from
#               config/atlas_profiles.txt + the Atlas CLI.
#
# Usage:
#   ./scripts/dev_apps.sh            install-if-missing, register, import, open both apps
#   ./scripts/dev_apps.sh --check    report only, change nothing
#   ./scripts/dev_apps.sh export     OLD Mac: export Compass connections (no secrets)
#                                    to the Dropbox transfer dir, for the new Mac
#
# The export file holds hostnames and usernames but NO passwords (no passphrase
# = Compass omits secrets). It is written 0600 to the workspace's
# .machine-transfer/ (Dropbox, outside git) — the only channel to the new Mac.
# Atlas-CLI-built files go to ~/.myai/ (0600, never synced).
#
# bash 3.2-safe; never stops on one failure — every step prints OK / SKIP / FAIL.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WS="$(dirname "$REPO")"
API_DIR="${API_MANAGEMENT_DIR:-$WS/api_management}"
XFER="${MYAI_TRANSFER_DIR:-$WS/.machine-transfer}"
COMPASS_APP="/Applications/MongoDB Compass.app"
COMPASS_BIN="$COMPASS_APP/Contents/MacOS/MongoDB Compass"
BRUNO_APP="/Applications/Bruno.app"
ATLAS_FILE="$HOME/.myai/compass-atlas-connections.json"
MARK="$HOME/.myai/.compass-imported"
CHECK=0; MODE=run
case "${1:-}" in
  --check) CHECK=1 ;;
  export) MODE="export" ;;
  "") ;;
  -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "dev_apps: unknown option $1 (--check | export)" >&2; exit 2 ;;
esac
RES=""; NFAIL=0
row() { RES="$RES
$1|$2|$3"; [ "$1" = FAIL ] && NFAIL=$((NFAIL+1)); printf '[%s] %s — %s\n' "$1" "$2" "$3"; }
act() { [ "$CHECK" = 0 ]; }
for p in /opt/homebrew/bin /usr/local/bin; do [ -x "$p/brew" ] && eval "$("$p/brew" shellenv)"; done

# ── export (old Mac) ─────────────────────────────────────────────────────────
if [ "$MODE" = export ]; then
  [ -x "$COMPASS_BIN" ] || { echo "dev_apps: MongoDB Compass not installed here"; exit 1; }
  mkdir -p "$XFER" || exit 1
  out="$XFER/compass-connections-$(hostname -s).json"
  # No --passphrase: Compass then strips every password from the export.
  if ( umask 077; "$COMPASS_BIN" --export-connections="$out" >/dev/null 2>&1 ) && [ -s "$out" ]; then
    chmod 600 "$out"
    echo "exported Compass connections (no passwords) -> $out"
    echo "On the new Mac: ./scripts/dev_apps.sh"
  else
    echo "dev_apps: export failed — quit Compass (Cmd-Q) and re-run, or export from Compass: Connections menu > Export"
    exit 1
  fi
  exit 0
fi

have_app() { [ -d "$1" ]; }
cask() {  # cask <app-path> <cask-name> <label>
  if have_app "$1"; then row OK "$3" "installed"
  elif ! act; then row SKIP "$3" "not installed (would: brew install --cask $2)"
  elif command -v brew >/dev/null 2>&1 && brew install --cask "$2" >/dev/null 2>&1 && have_app "$1"; then row OK "$3" "installed now"
  else row FAIL "$3" "brew install --cask $2 failed — install it from Self Service or the vendor site"; fi
}

echo "── Bruno ──"
cask "$BRUNO_APP" bruno Bruno
if [ -f "$API_DIR/scripts/setup_bruno.sh" ]; then
  ncol="$(find "$API_DIR/bruno" -name bruno.json -maxdepth 4 2>/dev/null | wc -l | tr -d ' ')"
  if ! act; then row SKIP bruno-collections "$ncol collections found (would register via setup_bruno.sh)"
  elif out="$(bash "$API_DIR/scripts/setup_bruno.sh" 2>&1)"; then
    row OK bruno-collections "$ncol collections registered + trusted"
    miss="$(printf '%s\n' "$out" | grep -ciE 'missing .env|no \.env')"
    [ "${miss:-0}" -gt 0 ] && row SKIP bruno-secrets "$miss collection(s) have no .env — Dropbox not finished, or recreate from your password manager"
  else row FAIL bruno-collections "setup_bruno.sh failed: $(printf '%s' "$out" | tail -1)"; fi
else row FAIL bruno-collections "api_management not found at $API_DIR (Dropbox not synced?)"; fi

echo; echo "── MongoDB Compass ──"
cask "$COMPASS_APP" mongodb-compass Compass
# THE STANDARD (2026-10-02): api_management/scripts/setup_compass.sh builds the
# full set — every app's own DB (Atlas + local Docker, from each repo's env file
# and compose) + the committed catalog — WITH passwords into the git-ignored,
# Dropbox-synced config/compass_connections.local.json, and imports it. So on
# any Mac, Compass opens with every database connectable, RAG/vectors included.
SETUP_COMPASS="$API_DIR/scripts/setup_compass.sh"
if [ -f "$SETUP_COMPASS" ]; then
  if ! have_app "$COMPASS_APP"; then row SKIP compass-connections "Compass not installed yet — re-run after the cask install"
  elif ! act; then row SKIP compass-connections "would run setup_compass.sh ($(bash "$SETUP_COMPASS" --list 2>/dev/null | head -1))"
  elif out="$(bash "$SETUP_COMPASS" 2>&1)"; then
    row OK compass-connections "$(printf '%s\n' "$out" | grep -m1 -oE '[0-9]+ connection\(s\)') imported with passwords (setup_compass.sh)"
  else row FAIL compass-connections "setup_compass.sh failed: $(printf '%s' "$out" | tail -1)"; fi
else
# Newest export wins; a glob + -nt instead of `ls -t` so odd filenames survive.
src=""
for f in "$XFER"/compass-connections-*.json; do
  [ -f "$f" ] || continue
  if [ -z "$src" ] || [ "$f" -nt "$src" ]; then src="$f"; fi
done
if [ -z "$src" ]; then
  # Fallback: credential-less Atlas connections for the repos in atlas_profiles.txt.
  if command -v atlas >/dev/null 2>&1 && [ -f "$REPO/config/atlas_profiles.txt" ]; then
    if act; then
      mkdir -p "$HOME/.myai"
      ( umask 077; python3 - "$REPO/config/atlas_profiles.txt" "$ATLAS_FILE" <<'PY'
import json, subprocess, sys, uuid
rows, seen, conns = open(sys.argv[1]).read().splitlines(), set(), []
def atlas(*a):
    r = subprocess.run(["atlas", *a, "-o", "json"], capture_output=True, text=True, timeout=60)
    return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None
for line in rows:
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    f = [x.strip() for x in line.split("|")]
    if len(f) < 4 or (f[1], f[2], f[3]) in seen:
        continue
    seen.add((f[1], f[2], f[3]))
    projs = atlas("projects", "list", "--profile", f[1]) or {}
    pid = next((p["id"] for p in projs.get("results", []) if p.get("name") == f[2]), None)
    cs = pid and atlas("clusters", "connectionStrings", "describe", f[3], "--projectId", pid, "--profile", f[1])
    uri = cs and cs.get("standardSrv")
    if uri:  # SRV host only — no user, no password; Compass asks for them
        conns.append({"id": str(uuid.uuid4()), "connectionOptions": {"connectionString": uri},
                      "favorite": {"name": f"{f[1]} · {f[2]} · {f[3]}"}})
if not conns:
    sys.exit(1)
json.dump({"type": "Compass Connections", "version": {"$numberInt": "1"}, "connections": conns}, open(sys.argv[2], "w"), indent=2)
PY
      ) && src="$ATLAS_FILE" && row OK compass-atlas "built credential-less Atlas connections -> $ATLAS_FILE"
      [ -z "$src" ] && row SKIP compass-atlas "Atlas CLI not logged in for those profiles (atlas auth login --profile <profile>)"
    else row SKIP compass-atlas "would build Atlas connections from atlas_profiles.txt"; fi
  else row SKIP compass-connections "no export in $XFER — on the old Mac run: ./scripts/dev_apps.sh export"; fi
fi
if [ -n "$src" ]; then
  sum="$(shasum -a 256 "$src" | awk '{print $1}')"
  if [ "$(cat "$MARK" 2>/dev/null)" = "$sum" ]; then row OK compass-connections "$(basename "$src") already imported"
  elif ! act; then row SKIP compass-connections "would import $(basename "$src")"
  elif [ -x "$COMPASS_BIN" ] && "$COMPASS_BIN" --import-connections="$src" >/dev/null 2>&1; then
    mkdir -p "$HOME/.myai"; printf '%s\n' "$sum" > "$MARK"
    row OK compass-connections "imported $(basename "$src") — enter each password once (not exported, by design)"
  else row FAIL compass-connections "import failed — quit Compass (Cmd-Q) and re-run, or Compass: Connections menu > Import > $src"; fi
fi

fi

echo; echo "── open ──"
if act; then
  have_app "$BRUNO_APP" && open -a Bruno && row OK open-bruno launched
  have_app "$COMPASS_APP" && open -a "MongoDB Compass" && row OK open-compass launched
else row SKIP open "--check"; fi

echo; echo "── dev apps: summary ($NFAIL failed) ──"
printf '%s\n' "$RES" | sed '/^$/d' | awk -F'|' '{printf "  %-5s %-20s %s\n", $1, $2, $3}'
[ "$NFAIL" = 0 ]
