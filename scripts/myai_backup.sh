#!/usr/bin/env bash
# myai_backup.sh — snapshot the brain + local config to a dated archive (`myai backup`).
#
#   myai backup [dir] [--out <file>] [--quiet]
#       Tar the git-versioned brain repo AND the ~/.myai config files
#       (config, brain.path) into ONE portable, dated .tar.gz archive:
#
#         myai-backup-<host>-<YYYYMMDD-HHMMSS>.tar.gz
#           manifest.json        metadata (version, host, brain HEAD, counts)
#           config/              top-level files under $MYAI_HOME (config,
#                                brain.path) — the brain/ subdir is excluded
#                                here (it's archived under brain/ below)
#           brain/               the FULL brain repo including .git — so the
#                                restore is a bit-exact clone, history intact
#
#       [dir]         write the archive INTO this directory (default: cwd)
#       --out <file>  write the archive to this exact path (overrides [dir])
#       --quiet       print only the archive path (for scripting)
#
#       Round-trip with `myai restore <archive>`. The archive is embedding- and
#       machine-agnostic: brain paths are re-resolved on restore, so a backup
#       taken on one Mac restores cleanly on another.
#
# Resolution (mirrors scripts/lib/brain.sh):
#   $MYAI_HOME       config home           (default ~/.myai)
#   $MYAI_BRAIN_DIR → $MYAI_HOME/brain.path → $MYAI_HOME/brain   (brain repo)
#
# Sourceable stub-free: no gateway / network / Docker needed — just tar + git.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# brain_dir/brain_home resolution live in the shared lib; fall back to inline
# defaults if the lib is missing (keeps backup working from a partial checkout).
# shellcheck source=lib/brain.sh
if ! . "$HERE/lib/brain.sh" 2>/dev/null; then
  brain_home() { printf '%s\n' "${MYAI_HOME:-$HOME/.myai}"; }
  brain_dir() {
    if [ -n "${MYAI_BRAIN_DIR:-}" ]; then printf '%s\n' "$MYAI_BRAIN_DIR"; return 0; fi
    local ptr; ptr="$(brain_home)/brain.path"
    if [ -f "$ptr" ]; then local p; p="$(head -1 "$ptr" 2>/dev/null)"; [ -n "$p" ] && { printf '%s\n' "$p"; return 0; }; fi
    printf '%s\n' "$(brain_home)/brain"
  }
fi

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; }

QUIET=0 OUT="" DEST_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) shift; OUT="${1:?--out needs a path}";;
    --quiet|-q) QUIET=1;;
    -h|--help) usage; exit 0;;
    -*) echo "myai backup: unknown flag $1" >&2; usage >&2; exit 2;;
    *) DEST_DIR="$1";;
  esac; shift
done

say() { [ "$QUIET" = "1" ] || echo "$@"; }

HOME_DIR="$(brain_home)"
BRAIN="$(brain_dir)"
HOST="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | sed 's/^-*//;s/-*$//')"
[ -n "$HOST" ] || HOST="host"
TS="$(date +%Y%m%d-%H%M%S)"

# Resolve the final archive path.
if [ -n "$OUT" ]; then
  ARCHIVE="$OUT"
  mkdir -p "$(dirname "$ARCHIVE")"
else
  DEST_DIR="${DEST_DIR:-$PWD}"
  mkdir -p "$DEST_DIR"
  ARCHIVE="$DEST_DIR/myai-backup-$HOST-$TS.tar.gz"
fi

# Nothing to back up? Bail loudly rather than writing an empty archive.
have_brain=0; have_config=0
[ -d "$BRAIN" ] && have_brain=1
[ -d "$HOME_DIR" ] && ls -A "$HOME_DIR" >/dev/null 2>&1 && \
  find "$HOME_DIR" -maxdepth 1 -type f 2>/dev/null | grep -q . && have_config=1
if [ "$have_brain" = "0" ] && [ "$have_config" = "0" ]; then
  echo "✗ nothing to back up — no brain repo at $BRAIN and no config files under $HOME_DIR" >&2
  echo "  (run 'myai brain init' first, or set \$MYAI_HOME / \$MYAI_BRAIN_DIR)" >&2
  exit 1
fi

STAGE="$(mktemp -d -t myai-backup.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

# ── config: the top-level files directly under $MYAI_HOME (config, brain.path,
#    any *.json / pointer). The brain/ subdir is deliberately skipped — it is
#    captured whole under brain/ below. ────────────────────────────────────────
config_files=0
if [ "$have_config" = "1" ]; then
  mkdir -p "$STAGE/config"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    cp -p "$f" "$STAGE/config/"
    config_files=$((config_files + 1))
  done < <(find "$HOME_DIR" -maxdepth 1 -type f 2>/dev/null)
fi

# ── brain: the whole repo, .git and all, so restore is a lossless clone. ──────
brain_head="" brain_branch="" brain_sessions=0 brain_handoffs=0 brain_memory=0
if [ "$have_brain" = "1" ]; then
  mkdir -p "$STAGE/brain"
  # cp -a preserves symlinks/perms; the trailing /. copies contents (incl. dotfiles).
  cp -a "$BRAIN/." "$STAGE/brain/" 2>/dev/null || cp -R "$BRAIN/." "$STAGE/brain/"
  if [ -d "$STAGE/brain/.git" ]; then
    brain_head="$(git -C "$STAGE/brain" rev-parse HEAD 2>/dev/null || echo '')"
    brain_branch="$(git -C "$STAGE/brain" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  fi
  brain_sessions="$(find "$STAGE/brain/repos" -path '*/sessions/*.md' 2>/dev/null | wc -l | tr -d ' ')"
  brain_handoffs="$(find "$STAGE/brain/repos" -path '*/handoffs/*.md' 2>/dev/null | wc -l | tr -d ' ')"
  brain_memory="$(find "$STAGE/brain/memory" -name '*.md' -not -name '.gitkeep' 2>/dev/null | wc -l | tr -d ' ')"
fi

# ── manifest ──────────────────────────────────────────────────────────────────
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if command -v jq >/dev/null 2>&1; then
  jq -n \
    --arg host "$HOST" --arg created "$created_at" \
    --arg home "$HOME_DIR" --arg brainDir "$BRAIN" \
    --arg head "$brain_head" --arg branch "$brain_branch" \
    --argjson hasBrain "$have_brain" --argjson hasConfig "$have_config" \
    --argjson configFiles "$config_files" \
    --argjson sessions "${brain_sessions:-0}" \
    --argjson handoffs "${brain_handoffs:-0}" \
    --argjson memory "${brain_memory:-0}" \
    '{kind:"myai-backup", formatVersion:1, createdAt:$created, host:$host,
      home:$home, brainDir:$brainDir,
      brain:{present:($hasBrain==1), head:$head, branch:$branch,
             sessions:$sessions, handoffs:$handoffs, memory:$memory},
      config:{present:($hasConfig==1), files:$configFiles}}' \
    > "$STAGE/manifest.json"
else
  # jq-free fallback — hand-rolled JSON (values here are all safe: no quotes).
  {
    printf '{"kind":"myai-backup","formatVersion":1,"createdAt":"%s","host":"%s",' "$created_at" "$HOST"
    printf '"home":"%s","brainDir":"%s",' "$HOME_DIR" "$BRAIN"
    printf '"brain":{"present":%s,"head":"%s","branch":"%s","sessions":%s,"handoffs":%s,"memory":%s},' \
      "$([ "$have_brain" = 1 ] && echo true || echo false)" "$brain_head" "$brain_branch" \
      "${brain_sessions:-0}" "${brain_handoffs:-0}" "${brain_memory:-0}"
    printf '"config":{"present":%s,"files":%s}}\n' \
      "$([ "$have_config" = 1 ] && echo true || echo false)" "$config_files"
  } > "$STAGE/manifest.json"
fi

# ── tar it up (deterministic top-level layout: manifest.json, config/, brain/) ─
tar -czf "$ARCHIVE" -C "$STAGE" manifest.json \
  $([ "$have_config" = 1 ] && echo config) \
  $([ "$have_brain" = 1 ] && echo brain)

size="$(du -h "$ARCHIVE" 2>/dev/null | cut -f1 | tr -d ' ')"
if [ "$QUIET" = "1" ]; then
  printf '%s\n' "$ARCHIVE"
else
  echo "✓ Backup written: $ARCHIVE (${size:-?})"
  [ "$have_brain" = 1 ] && echo "  brain:  ${brain_branch:-?} @ ${brain_head:0:8} — $brain_sessions sessions · $brain_handoffs handoffs · $brain_memory memory"
  [ "$have_config" = 1 ] && echo "  config: $config_files file(s) from $HOME_DIR"
  echo "  Restore with: myai restore $ARCHIVE"
fi
