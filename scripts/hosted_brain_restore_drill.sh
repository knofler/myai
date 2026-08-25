#!/usr/bin/env bash
# hosted_brain_restore_drill.sh — automates the ADR-036 §6 follow-up: the
# quarterly "restore a backup and prove it actually works" drill that §5
# described as an operator runbook step, not a script.
#
# Distinct from `hosted_brain_backup.sh --restore`: that primitive restores
# ONE named tenant back onto the live host (operator-invoked, real recovery,
# defaults to writing into $HOSTED_ROOT). This script restores EVERY tenant
# in the chosen archive into a throwaway scratch dir, verifies each restored
# repo with `git fsck` + expected bare-repo file presence, then discards the
# scratch copy — a rehearsal that never touches $HOSTED_ROOT or the live
# backup archive.
#
#   ./scripts/hosted_brain_restore_drill.sh                 # drill the newest archive in $HOSTED_BRAIN_BACKUP_DIR
#   ./scripts/hosted_brain_restore_drill.sh --archive <f>    # drill a specific archive (tests, ad-hoc)
#   ./scripts/hosted_brain_restore_drill.sh --quiet          # print only the final PASS/FAIL line
#
# Resolution (mirrors hosted_brain_backup.sh):
#   $MYAI_HOME                        config home                (default ~/.myai)
#   $HOSTED_BRAIN_BACKUP_DIR           where archives live         (default $MYAI_HOME/hosted-brain-backups)
#   $HOSTED_BRAIN_RESTORE_DRILL_LAST   status file (ADR-036 §5 `.last` convention)
#                                                                  (default $MYAI_HOME/hosted-brain-restore-drill.last)
#
# Exit 0 = archive found, every tenant inside it restored + verified clean
#          (or the archive legitimately covers zero tenants — ADR-036 §4's
#          "empty host" case is not a failure here either).
# Exit 0 with a SKIP result = no archive exists yet to drill (fresh host,
#          backup cron hasn't run) — not a broken-backup finding, so it does
#          not fail a cron/CI run, but it IS recorded in the `.last` file.
# Exit 1 = drill found a real problem: unreadable/corrupt archive, missing
#          manifest, a tenant whose restored repo fails `git fsck`, is
#          missing its HEAD, or is missing the bare-repo layout files. Loud
#          and non-zero on purpose — mirrors ADR-036 §2.2's "visible gap,
#          never silent" posture instead of a quietly-broken backup.
#
# Dependency-free besides tar/git/find (jq used opportunistically for the
# manifest cross-check, same fallback discipline as hosted_brain_backup.sh).
set -uo pipefail

usage() { sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; }

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKUP_SCRIPT="$HERE/hosted_brain_backup.sh"

MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
BACKUP_DIR="${HOSTED_BRAIN_BACKUP_DIR:-$MYAI_HOME/hosted-brain-backups}"
LAST_RUN_FILE="${HOSTED_BRAIN_RESTORE_DRILL_LAST:-$MYAI_HOME/hosted-brain-restore-drill.last}"

QUIET=0
ARCHIVE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --archive) shift; ARCHIVE="${1:?--archive needs a path}" ;;
    --quiet|-q) QUIET=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "hosted_brain_restore_drill: unknown flag $1" >&2; usage >&2; exit 2 ;;
    *) echo "hosted_brain_restore_drill: unexpected argument $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { [ "$QUIET" = "1" ] || echo "$@"; }

write_status() {
  # $1=result  $2=archive  $3=detail
  mkdir -p "$(dirname "$LAST_RUN_FILE")"
  {
    echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "archive: ${2:-none}"
    echo "result: $1"
    echo "detail: $3"
  } > "$LAST_RUN_FILE"
}

# ── locate the archive to drill ─────────────────────────────────────────────
if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$(find "$BACKUP_DIR" -maxdepth 1 -name 'hosted-brain-backup-*.tar.gz' 2>/dev/null | sort | tail -1)"
fi

if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  say "— no backup archive found under $BACKUP_DIR — nothing to drill yet —"
  write_status "SKIP" "" "no archive present under $BACKUP_DIR"
  exit 0
fi

SCRATCH="$(mktemp -d -t hosted-brain-restore-drill.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail_drill() {
  echo "✗ RESTORE DRILL FAILED: $1" >&2
  write_status "FAIL" "$ARCHIVE" "$1"
  exit 1
}

# ── extract (this is itself the first integrity check — a corrupt tar.gz
# fails right here rather than silently producing a partial scratch tree) ──
if ! tar -xzf "$ARCHIVE" -C "$SCRATCH" 2>/dev/null; then
  fail_drill "archive is unreadable/corrupt (tar extraction failed): $ARCHIVE"
fi

[ -f "$SCRATCH/manifest.json" ] || fail_drill "archive missing manifest.json: $ARCHIVE"

# ── enumerate restored tenant repos ─────────────────────────────────────────
tenant_dirs=()
while IFS= read -r d; do
  [ -n "$d" ] && tenant_dirs+=("$d")
done < <(find "$SCRATCH/tenants" -maxdepth 1 -type d -name '*.git' 2>/dev/null | sort)

manifest_count=""
if command -v jq >/dev/null 2>&1; then
  manifest_count="$(jq -r '.tenantCount // (.tenants | length)' "$SCRATCH/manifest.json" 2>/dev/null || echo '')"
fi
if [ -n "$manifest_count" ] && [ "$manifest_count" -ne "${#tenant_dirs[@]}" ] 2>/dev/null; then
  fail_drill "manifest declares $manifest_count tenant(s) but archive contains ${#tenant_dirs[@]} tenant repo(s)"
fi

if [ "${#tenant_dirs[@]}" -eq 0 ]; then
  say "✓ archive covers zero tenants (fresh/empty host per ADR-036 §4) — nothing to verify, drill passes"
  write_status "PASS" "$ARCHIVE" "0 tenants — empty archive"
  exit 0
fi

say "— drilling $ARCHIVE (${#tenant_dirs[@]} tenant repo(s)) —"

fail_reasons=()
pass_count=0

for dir in "${tenant_dirs[@]}"; do
  tid="$(basename "$dir" .git)"

  # expected bare-repo file presence
  if [ ! -f "$dir/HEAD" ] || [ ! -d "$dir/objects" ] || [ ! -d "$dir/refs" ]; then
    fail_reasons+=("$tid: missing expected bare-repo layout (HEAD/objects/refs)")
    continue
  fi

  # git fsck — catches corrupted objects/packs that a plain file-presence
  # check would miss (the actual "backups you've never restored aren't
  # backups" failure mode this drill exists for)
  if ! fsck_out="$(git -C "$dir" fsck --full 2>&1)"; then
    fail_reasons+=("$tid: git fsck failed: $(echo "$fsck_out" | head -1)")
    continue
  fi

  restored_head="$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo '')"
  if [ -z "$restored_head" ]; then
    fail_reasons+=("$tid: no resolvable HEAD after restore")
    continue
  fi

  if command -v jq >/dev/null 2>&1; then
    recorded_head="$(jq -r --arg t "$tid" '.tenants[] | select(.tenantId==$t) | .head // ""' "$SCRATCH/manifest.json" 2>/dev/null || echo '')"
    if [ -n "$recorded_head" ] && [ "$recorded_head" != "$restored_head" ]; then
      fail_reasons+=("$tid: manifest HEAD $recorded_head != restored HEAD $restored_head")
      continue
    fi
  fi

  pass_count=$((pass_count + 1))
  say "  ok   — $tid (HEAD ${restored_head:0:8}, fsck clean)"
done

if [ "${#fail_reasons[@]}" -gt 0 ]; then
  for r in "${fail_reasons[@]}"; do echo "  FAIL — $r" >&2; done
  fail_drill "${#fail_reasons[@]}/${#tenant_dirs[@]} tenant(s) failed verification: ${fail_reasons[0]}"
fi

say "✓ RESTORE DRILL PASSED: $pass_count/${#tenant_dirs[@]} tenant(s) restored + verified clean from $ARCHIVE"
write_status "PASS" "$ARCHIVE" "$pass_count/${#tenant_dirs[@]} tenant(s) verified clean"
exit 0
