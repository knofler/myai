#!/usr/bin/env python3
"""pool_capacity_drift.py — ground-truth cross-check for pool-capacity.json's
claude-tech daily/weekly spent-token figures (task-0824a68e).

pool_capacity_snapshot.sh's claude-tech numbers come from an INCREMENTAL
ledger (scripts/lib/session_tokens.py snapshot/delta, wired into
cli_task_runner.sh): each runner fire snapshots every transcript's byte-offset
before a session and adds only the output-token delta parsed past that offset.
That bookkeeping can silently drift from reality — a missed transcript file, a
snapshot marker lost across a runner restart, a CLAUDE_CONFIG_DIR mismatch —
without ever raising an error. A bug there would silently mis-route the
capability×cost×availability router (task-21dc2746) and the API-credit
reserve (task-874364a3), both of which trust state/pool-capacity.json as
ground truth, for however long it takes a human to notice.

This module re-derives the SAME figures a different way: it sums
message.usage.output_tokens directly from every transcript line whose
top-level "timestamp" falls inside the current Sydney day/week window (the
same boundaries cli_task_runner.sh's pace_day()/pace_week() use) — no offset
bookkeeping, no snapshot markers, just a fresh read of what the provider
actually returned for that window. Agreement (within tolerance) between the
two independently-computed numbers IS the self-check; this never rewrites
either side — drift is logged, not auto-corrected (a human should look at a
persistent large drift; a recompute "fixing" the ledger could just as easily
paper over the real bug).

Usage:
  pool_capacity_drift.py <pool-capacity.json> <config-dir> [tolerance_pct] [tolerance_floor_tokens]

Env:
  POOL_CAPACITY_DRIFT_STATUS_OUT  optional path to also write a JSON bridge
                                   artifact (checkedAt/generatedAt/anyDrift/
                                   windows[]) for runtime/src/monitoring/
                                   pool-capacity-drift-alerter.ts to read —
                                   same bridge pattern as
                                   docker_vm_disk_snapshot.sh's JSON output.

Prints one line per window (day, week):
  OK    day  recorded=<n> actual=<n> diff=<n> diffPct=<x> ...
  DRIFT week recorded=<n> actual=<n> diff=<n> diffPct=<x> ...
  SKIP  <reason>

A window only breaches (DRIFT) when BOTH the absolute diff clears
tolerance_floor AND the relative diff (against actual usage) clears
tolerance_pct — the same double-gate as budget-reconciliation.ts's
evaluateDrift, so a single in-flight session's tokens (not yet charged to the
ledger) don't trip a false alarm on an otherwise-healthy pool.

Exit: 0 if any window drifted, 0 on SKIP/error too — this is a monitoring
self-check, not a gate, so it never fails a caller. It DOES print "DRIFT" as
the line prefix so the caller (pool_capacity_drift_check.sh) can tell.
"""
import sys
import os
import glob
import json
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    SYDNEY = ZoneInfo("Australia/Sydney")
except Exception:
    SYDNEY = None


def _transcripts(cfg):
    return glob.glob(os.path.join(cfg, "projects", "**", "*.jsonl"), recursive=True)


def sum_output_tokens_window(cfg, start_iso, end_iso):
    """Sum message.usage.output_tokens across every transcript line whose
    top-level "timestamp" is in [start_iso, end_iso). Lexicographic string
    comparison is safe here because Claude Code always emits fixed-width,
    zero-padded UTC ISO-8601 timestamps ("...Z" suffix). Best-effort: unreadable
    files/lines are skipped, never raised."""
    total = 0
    for f in _transcripts(cfg):
        try:
            with open(f, encoding="utf-8", errors="ignore") as fh:
                for line in fh:
                    if '"output_tokens"' not in line or '"timestamp"' not in line:
                        continue
                    try:
                        d = json.loads(line)
                    except (ValueError, TypeError):
                        continue
                    ts = d.get("timestamp")
                    if not isinstance(ts, str) or not (start_iso <= ts < end_iso):
                        continue
                    usage = (d.get("message") or {}).get("usage") or {}
                    try:
                        total += int(usage.get("output_tokens", 0) or 0)
                    except (ValueError, TypeError):
                        pass
        except OSError:
            pass
    return total


def _parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _fmt(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def sydney_bounds(generated_at_iso):
    """(day_start_iso, week_start_iso, end_iso) in UTC 'Z' format — Sydney-local
    midnight for the day, Sydney-local Monday 00:00 (ISO week) for the week,
    matching cli_task_runner.sh's pace_day()/pace_week() exactly. Falls back to
    UTC boundaries if zoneinfo/tzdata is unavailable (best-effort, never raises
    past the caller's own try/except)."""
    end_dt = _parse_iso(generated_at_iso)
    local = end_dt.astimezone(SYDNEY) if SYDNEY is not None else end_dt.astimezone(timezone.utc)
    day_start_local = local.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start_local = day_start_local - timedelta(days=local.isoweekday() - 1)
    return _fmt(day_start_local), _fmt(week_start_local), _fmt(end_dt)


def evaluate(recorded, actual, tol_pct, tol_floor):
    """Double-gated drift evaluation (mirrors budget-reconciliation.ts's
    evaluateDrift): breach requires the absolute diff to clear tol_floor AND
    the relative diff (against actual, falling back to recorded when actual is
    0) to clear tol_pct."""
    diff = abs(recorded - actual)
    denom = actual if actual > 0 else recorded
    diff_pct = (diff * 100.0 / denom) if denom > 0 else 0.0
    breach = diff > tol_floor and diff_pct > tol_pct
    return diff, diff_pct, breach


def _write_status_json(path, payload):
    """Best-effort atomic write of the drift-check bridge artifact (same
    pattern as docker_vm_disk_snapshot.sh -> docker-vm-disk-alerter.ts): the
    gateway's runtime/src/monitoring/pool-capacity-drift-alerter.ts reads
    this off the repo mount and fires Telegram/dashboard-bell on DRIFT,
    instead of drift only ever reaching a log file a human has to tail.
    Never raises past the caller."""
    if not path:
        return
    try:
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        tmp = f"{path}.tmp.{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    except OSError:
        pass


def main(argv):
    if len(argv) < 3:
        print("usage: pool_capacity_drift.py <pool-capacity.json> <config-dir> [tolerance_pct] [tolerance_floor]")
        return 2
    snapshot_path, cfg = argv[1], argv[2]
    tol_pct = float(argv[3]) if len(argv) > 3 else 10.0
    tol_floor = float(argv[4]) if len(argv) > 4 else 5000.0
    status_out = os.environ.get("POOL_CAPACITY_DRIFT_STATUS_OUT")
    checked_at = _fmt(datetime.now(timezone.utc))

    try:
        with open(snapshot_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as e:
        print(f"SKIP no-snapshot ({e})")
        _write_status_json(status_out, {"checkedAt": checked_at, "skipped": "no-snapshot", "anyDrift": False, "windows": []})
        return 0

    generated_at = data.get("generatedAt")
    pools = data.get("pools") or []
    pool = next((p for p in pools if isinstance(p, dict) and p.get("pool") == "claude-tech"), None)
    if not generated_at or pool is None:
        print("SKIP claude-tech-pool-missing")
        _write_status_json(status_out, {"checkedAt": checked_at, "skipped": "claude-tech-pool-missing", "anyDrift": False, "windows": []})
        return 0

    try:
        day_start, week_start, end = sydney_bounds(generated_at)
    except Exception as e:
        print(f"SKIP bad-generatedAt ({e})")
        _write_status_json(status_out, {"checkedAt": checked_at, "skipped": "bad-generatedAt", "anyDrift": False, "windows": []})
        return 0

    any_drift = False
    windows = []
    for label, start, field in (
        ("day", day_start, "dailySpentTokens"),
        ("week", week_start, "weeklySpentTokens"),
    ):
        try:
            recorded = int(pool.get(field, 0) or 0)
        except (ValueError, TypeError):
            recorded = 0
        actual = sum_output_tokens_window(cfg, start, end)
        diff, diff_pct, breach = evaluate(recorded, actual, tol_pct, tol_floor)
        status = "DRIFT" if breach else "OK"
        any_drift = any_drift or breach
        print(
            f"{status} {label} recorded={recorded} actual={actual} diff={diff} "
            f"diffPct={diff_pct:.1f} tolPct={tol_pct:g} tolFloor={tol_floor:g} "
            f"window=[{start},{end}) generatedAt={generated_at}"
        )
        windows.append({
            "label": label,
            "status": status,
            "recorded": recorded,
            "actual": actual,
            "diff": diff,
            "diffPct": round(diff_pct, 1),
            "tolPct": tol_pct,
            "tolFloor": tol_floor,
            "windowStart": start,
            "windowEnd": end,
        })

    _write_status_json(status_out, {
        "checkedAt": checked_at,
        "generatedAt": generated_at,
        "pool": "claude-tech",
        "skipped": None,
        "anyDrift": any_drift,
        "windows": windows,
    })
    return 1 if any_drift else 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as e:
        print(f"SKIP error ({e})")
        sys.exit(0)
