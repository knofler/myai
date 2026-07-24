#!/usr/bin/env bash
# runner_log_rotate.sh — size/age-bounded rotation for ~/.ai-cli-runner/logs so a
# long-lived runner host never fills its disk.
#
# WHY: cli_task_runner.sh writes one job log per fire and never cleans up. Left
# alone the directory grows forever. This script, run after every fire (see
# cli_task_runner.sh tail) and safe to run any time, does three things in order:
#   1. gzip plain .log files older than LOG_COMPRESS_AFTER_DAYS (mtime-based)
#   2. delete .log.gz archives older than LOG_DELETE_AFTER_DAYS
#   3. if the dir is still over LOG_MAX_TOTAL_MB, delete the OLDEST .log.gz
#      archives first, then — only if still over cap — the oldest plain .log
#      files, until back under the cap
#
# Thresholds live in config/runner_log_retention.conf (Dropbox/git-synced, same
# on every Mac) — never hardcoded here.
#
# Distinct from: the searchable job-history archive (indexes log CONTENT for
# search) and the workspace janitor (prunes worktrees/branches). This script
# only governs raw job-log file lifecycle on disk.
#
#   ./scripts/runner_log_rotate.sh                # rotate $HOME/.ai-cli-runner/logs
#   ./scripts/runner_log_rotate.sh --dry-run       # report what would happen, change nothing
#   LOG_ROOT=/tmp/x ./scripts/runner_log_rotate.sh # rotate a different dir (tests)
#
# Sourced with RUNNER_LIB_ONLY=1 (scripts/tests/test_runner_log_rotate.sh) to unit
# test the individual functions without touching the real log dir.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# ── Config (thresholds; env overrides win, then config file, then defaults) ──
_LOG_RETENTION_CONF="${RUNNER_LOG_RETENTION_CONF:-$SCRIPT_DIR/../config/runner_log_retention.conf}"
[ -f "$_LOG_RETENTION_CONF" ] && . "$_LOG_RETENTION_CONF" 2>/dev/null || true
RUNNER_LOG_ROTATION="${RUNNER_LOG_ROTATION:-on}"
LOG_COMPRESS_AFTER_DAYS="${LOG_COMPRESS_AFTER_DAYS:-3}"
LOG_DELETE_AFTER_DAYS="${LOG_DELETE_AFTER_DAYS:-30}"
LOG_MAX_TOTAL_MB="${LOG_MAX_TOTAL_MB:-500}"

LOG_ROOT="${LOG_ROOT:-$HOME/.ai-cli-runner/logs}"
DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
    esac
done

rlr_log() { printf '[runner_log_rotate] %s\n' "$1" >&2; }

# Portable mtime-as-epoch: GNU stat (-c) first, BSD/macOS stat (-f) fallback.
# GNU-first is deliberate — on Linux `stat -f %m` is a *filesystem* query that
# emits a multi-line dump with exit 0 (never falling through), whereas `stat -c`
# fails cleanly on BSD (illegal option) and falls through to `-f`.
rlr_mtime_epoch() {
    stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

# Total size of a directory in MB (0 if the dir doesn't exist).
rlr_dir_size_mb() {
    local dir="$1"
    [ -d "$dir" ] || { echo 0; return; }
    du -sm "$dir" 2>/dev/null | awk '{print $1}' | head -1
}

# gzip plain .log files whose mtime is older than $2 days. Prints the count
# compressed. Respects $3=dry-run (1=report only, no writes).
rlr_compress_old() {
    local dir="$1" days="$2" dry="${3:-0}" n=0 f
    [ -d "$dir" ] || { echo 0; return; }
    while IFS= read -r -d '' f; do
        n=$((n + 1))
        if [ "$dry" = "1" ]; then
            rlr_log "would compress: $f"
        else
            gzip -f "$f" 2>/dev/null && rlr_log "compressed: $f"
        fi
    done < <(find "$dir" -maxdepth 1 -type f -name '*.log' -mtime "+$days" -print0 2>/dev/null)
    echo "$n"
}

# Delete .log.gz archives whose mtime is older than $2 days. Prints the count deleted.
rlr_delete_expired_archives() {
    local dir="$1" days="$2" dry="${3:-0}" n=0 f
    [ -d "$dir" ] || { echo 0; return; }
    while IFS= read -r -d '' f; do
        n=$((n + 1))
        if [ "$dry" = "1" ]; then
            rlr_log "would delete (expired): $f"
        else
            rm -f "$f" && rlr_log "deleted (expired): $f"
        fi
    done < <(find "$dir" -maxdepth 1 -type f -name '*.log.gz' -mtime "+$days" -print0 2>/dev/null)
    echo "$n"
}

# List files in $dir matching glob $2 (e.g. '*.log.gz'), oldest mtime first.
rlr_oldest_first() {
    local dir="$1" pattern="$2" f
    while IFS= read -r -d '' f; do
        printf '%s %s\n' "$(rlr_mtime_epoch "$f")" "$f"
    done < <(find "$dir" -maxdepth 1 -type f -name "$pattern" -print0 2>/dev/null) | sort -n | cut -d' ' -f2-
}

# Delete oldest-first (archives, then plain logs) until the dir is back under
# $2 MB. Prints the count deleted. Tracks the running total from each
# candidate file's own byte size (rather than re-`du`-ing the dir) so
# dry-run's simulated deletions and a real run stop at the same point.
rlr_enforce_size_cap() {
    local dir="$1" max_mb="$2" dry="${3:-0}" n=0 f fbytes running_mb
    [ -d "$dir" ] || { echo 0; return; }
    running_mb="$(rlr_dir_size_mb "$dir")"
    if [ "${running_mb:-0}" -le "$max_mb" ] 2>/dev/null; then
        echo 0
        return
    fi
    for f in $(rlr_oldest_first "$dir" '*.log.gz') $(rlr_oldest_first "$dir" '*.log'); do
        [ "${running_mb:-0}" -le "$max_mb" ] 2>/dev/null && break
        fbytes=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null || echo 0)
        n=$((n + 1))
        if [ "$dry" = "1" ]; then
            rlr_log "would delete (size cap): $f"
        else
            rm -f "$f" && rlr_log "deleted (size cap): $f"
        fi
        running_mb=$((running_mb - (fbytes / 1048576)))
        [ "$running_mb" -lt 0 ] && running_mb=0
    done
    echo "$n"
}

rlr_run() {
    if [ "$RUNNER_LOG_ROTATION" != "on" ]; then
        rlr_log "skipped — RUNNER_LOG_ROTATION=$RUNNER_LOG_ROTATION"
        return 0
    fi
    if [ ! -d "$LOG_ROOT" ]; then
        rlr_log "skipped — no log dir at $LOG_ROOT"
        return 0
    fi

    local compressed deleted_expired deleted_cap before_mb after_mb
    before_mb="$(rlr_dir_size_mb "$LOG_ROOT")"
    compressed="$(rlr_compress_old "$LOG_ROOT" "$LOG_COMPRESS_AFTER_DAYS" "$DRY_RUN")"
    deleted_expired="$(rlr_delete_expired_archives "$LOG_ROOT" "$LOG_DELETE_AFTER_DAYS" "$DRY_RUN")"
    deleted_cap="$(rlr_enforce_size_cap "$LOG_ROOT" "$LOG_MAX_TOTAL_MB" "$DRY_RUN")"
    after_mb="$(rlr_dir_size_mb "$LOG_ROOT")"

    rlr_log "done — compressed=$compressed deleted_expired=$deleted_expired deleted_size_cap=$deleted_cap size=${before_mb}MB→${after_mb}MB (cap ${LOG_MAX_TOTAL_MB}MB)$([ "$DRY_RUN" = "1" ] && echo ' [dry-run]')"
}

# When sourced with RUNNER_LIB_ONLY=1 (scripts/tests/test_runner_log_rotate.sh),
# expose the functions above without executing main.
if [ "${RUNNER_LIB_ONLY:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

rlr_run
