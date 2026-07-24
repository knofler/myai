#!/usr/bin/env bash
# myai_restore.sh — restore a brain + config snapshot from an archive (`myai restore`).
#
#   myai restore <archive.tar.gz> [--to <brain-dir>] [--force] [--dry-run] [--quiet]
#       Unpack a `myai backup` archive and restore:
#         • the brain repo  → this machine's resolved brain dir (or --to <dir>)
#         • the config files → $MYAI_HOME (config, brain.path)
#
#       By default restore REFUSES to clobber an existing, non-empty target —
#       pass --force to proceed (the existing brain dir / config files are moved
#       aside to <path>.bak-<ts> first, never deleted).
#
#       --to <dir>    restore the brain into <dir> instead of the resolved dir
#       --force       overwrite existing brain/config (prior state → .bak-<ts>)
#       --dry-run     print what WOULD happen; touch nothing
#       --quiet       minimal output
#
#       Machine-agnostic: the brain is restored to THIS machine's resolved
#       location, not the absolute path baked into the archive — so a backup
#       from one Mac restores cleanly on another. --to overrides.
#
# Resolution (mirrors scripts/lib/brain.sh):
#   $MYAI_HOME       config home           (default ~/.myai)
#   $MYAI_BRAIN_DIR → $MYAI_HOME/brain.path → $MYAI_HOME/brain   (brain repo)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
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

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; }

ARCHIVE="" TO="" FORCE=0 DRY=0 QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --to) shift; TO="${1:?--to needs a dir}";;
    --force|-f) FORCE=1;;
    --dry-run|-n) DRY=1;;
    --quiet|-q) QUIET=1;;
    -h|--help) usage; exit 0;;
    -*) echo "myai restore: unknown flag $1" >&2; usage >&2; exit 2;;
    *) ARCHIVE="$1";;
  esac; shift
done

[ -n "$ARCHIVE" ] || { echo "myai restore: archive path required" >&2; usage >&2; exit 2; }
[ -f "$ARCHIVE" ] || { echo "myai restore: no such archive: $ARCHIVE" >&2; exit 2; }

say() { [ "$QUIET" = "1" ] || echo "$@"; }

TS="$(date +%Y%m%d-%H%M%S)"
STAGE="$(mktemp -d -t myai-restore.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

# ── unpack + validate ─────────────────────────────────────────────────────────
tar -xzf "$ARCHIVE" -C "$STAGE" 2>/dev/null || {
  echo "✗ could not extract archive (not a gzip tar?): $ARCHIVE" >&2; exit 1; }

[ -f "$STAGE/manifest.json" ] || {
  echo "✗ archive is missing manifest.json — not a myai backup: $ARCHIVE" >&2; exit 1; }

kind=""
if command -v jq >/dev/null 2>&1; then
  kind="$(jq -r '.kind // empty' "$STAGE/manifest.json" 2>/dev/null || echo '')"
else
  grep -q '"kind"[[:space:]]*:[[:space:]]*"myai-backup"' "$STAGE/manifest.json" && kind="myai-backup"
fi
[ "$kind" = "myai-backup" ] || {
  echo "✗ manifest.json is not a myai-backup manifest (kind='$kind'): $ARCHIVE" >&2; exit 1; }

HOME_DIR="$(brain_home)"
BRAIN_TARGET="${TO:-$(brain_dir)}"

say "myai restore — from $(basename "$ARCHIVE")"
if command -v jq >/dev/null 2>&1; then
  say "  archive: host=$(jq -r '.host' "$STAGE/manifest.json") created=$(jq -r '.createdAt' "$STAGE/manifest.json") brain=$(jq -r '.brain.branch + " @ " + (.brain.head[0:8] // "")' "$STAGE/manifest.json")"
fi

# ── helper: safely stash an existing target aside before overwriting ──────────
stash_aside() {  # <path>
  local p="$1" bak="$1.bak-$TS"
  if [ "$DRY" = "1" ]; then say "  [dry-run] would move existing $p → $bak"; return 0; fi
  mv "$p" "$bak"
  say "  ↪ existing $p moved to $bak"
}

restored=0

# ── brain ─────────────────────────────────────────────────────────────────────
if [ -d "$STAGE/brain" ]; then
  brain_nonempty=0
  { [ -d "$BRAIN_TARGET" ] && find "$BRAIN_TARGET" -mindepth 1 2>/dev/null | grep -q .; } && brain_nonempty=1
  if [ "$brain_nonempty" = "1" ] && [ "$FORCE" != "1" ]; then
    echo "✗ brain target exists and is non-empty: $BRAIN_TARGET" >&2
    echo "  refusing to overwrite — re-run with --force (existing state is moved to .bak-<ts>, not deleted)" >&2
    exit 1
  fi
  if [ "$DRY" = "1" ]; then
    say "  [dry-run] would restore brain → $BRAIN_TARGET"
  else
    [ "$brain_nonempty" = "1" ] && stash_aside "$BRAIN_TARGET"
    mkdir -p "$BRAIN_TARGET"
    cp -a "$STAGE/brain/." "$BRAIN_TARGET/" 2>/dev/null || cp -R "$STAGE/brain/." "$BRAIN_TARGET/"
    say "  ✓ brain restored → $BRAIN_TARGET"
  fi
  restored=$((restored + 1))
fi

# ── config files → $MYAI_HOME (one by one; each existing file stashed aside) ──
if [ -d "$STAGE/config" ]; then
  [ "$DRY" = "1" ] || mkdir -p "$HOME_DIR"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    base="$(basename "$f")"
    dest="$HOME_DIR/$base"
    if [ "$DRY" = "1" ]; then
      say "  [dry-run] would restore config → $dest"
      continue
    fi
    [ -e "$dest" ] && [ "$FORCE" = "1" ] && stash_aside "$dest"
    if [ -e "$dest" ] && [ "$FORCE" != "1" ]; then
      say "  ⚠ keeping existing $dest (use --force to overwrite; skipped)"
      continue
    fi
    cp -p "$f" "$dest"
    say "  ✓ config restored → $dest"
    restored=$((restored + 1))
  done < <(find "$STAGE/config" -maxdepth 1 -type f 2>/dev/null)
fi

# The archived brain.path may point at the SOURCE machine's brain location.
# If we restored the brain to a different dir (--to, or a different $MYAI_HOME),
# repoint brain.path so `myai brain` on THIS machine finds the restored repo.
if [ "$DRY" != "1" ] && [ -d "$STAGE/brain" ] && [ -f "$HOME_DIR/brain.path" ]; then
  current="$(head -1 "$HOME_DIR/brain.path" 2>/dev/null || echo '')"
  if [ "$current" != "$BRAIN_TARGET" ]; then
    printf '%s\n' "$BRAIN_TARGET" > "$HOME_DIR/brain.path"
    say "  ↪ brain.path repointed → $BRAIN_TARGET"
  fi
fi

if [ "$DRY" = "1" ]; then
  say "  (dry-run — nothing was written)"
elif [ "$restored" = "0" ]; then
  echo "✗ archive contained neither a brain nor config to restore" >&2
  exit 1
else
  say "✓ Restore complete — verify with: myai brain status"
fi
