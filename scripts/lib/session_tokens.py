#!/usr/bin/env python3
"""session_tokens.py — precise per-session OUTPUT-token measurement for the runner's
credit-pacing throttle, with NO double-counting across fires.

Transcripts live at <config-dir>/projects/*/*.jsonl; each assistant turn carries
`message.usage.output_tokens`. To attribute exactly the tokens spent by ONE runner
session we snapshot every transcript's byte-size BEFORE the session, then after it
parse ONLY the bytes appended past that offset (plus any brand-new files). That delta
is this session's output tokens — re-running never re-counts old turns.

Usage:
  session_tokens.py snapshot <config-dir>            → prints JSON {path: size_bytes}
  session_tokens.py delta    <config-dir> <snapfile> → prints int (new output tokens)

  session_tokens.py reconcile <config-dir> <ledger-dir> [now-iso]
                                                     → raise tok-<day>/tok-<week> to the
                                                       transcript-derived POOL spend (all
                                                       sessions in the profile, minus the
                                                       API-key lane's apicredit-tok-* ledger)

WHY reconcile exists (2026-09-08, "Pool-capacity drift: CRITICAL"): the delta path
above attributes tokens to ONE runner fire, so tok-<day|week> only ever recorded
runner spend — while interactive sessions on the runner profile draw on the same Team pool
and were invisible to the router/reserve headroom (28% day / 45% week drift on
2026-09-08 was exactly one long interactive session). reconcile re-sums
message.usage.output_tokens for the Sydney day/week window straight from the
transcripts (same boundaries as cli_task_runner.sh's pace_day()/pace_week() and
pool_capacity_drift.py), subtracts the API-key lane (billed to API credit, not the
pool), and raises each ledger to that figure. MONOTONIC: it never lowers a ledger
— if transcripts say less than the ledger (pruned files, a real bookkeeping bug)
the ledger stands and pool_capacity_drift.py keeps alarming, which is the point
of that check. Writes tok-<key>.reconcile.json beside each ledger for audit.

Best-effort by contract: any error prints 0 / an empty snapshot and exits 0, so the
runner's always-on session-count cap remains the reliable guard (never fails open).
"""
import sys, os, glob, json


def _project_slug(cwd):
    """Claude Code files a session's transcript under projects/<slug>/, where slug is
    the absolute working dir with every non-alphanumeric char replaced by '-'."""
    import re
    return re.sub(r"[^A-Za-z0-9]", "-", os.path.abspath(cwd))


def _transcripts(cfg):
    # SESSION_TOKENS_CWD (2026-10-02, "Pool-capacity drift: CRITICAL" #2): when set,
    # count ONLY that working dir's transcripts. Without it every transcript under
    # the profile is diffed, so N concurrent runner fires (and any interactive
    # runner-profile session) each counted EVERYONE's output — the ledger read 7.0M
    # vs 3.0M actual and a swarm's token budget tripped on phantom spend. The
    # runner exports it per fire as its task worktree, which is unique per task.
    cwd = os.environ.get("SESSION_TOKENS_CWD", "").strip()
    if cwd:
        return glob.glob(os.path.join(cfg, "projects", _project_slug(cwd), "*.jsonl"))
    return glob.glob(os.path.join(cfg, "projects", "**", "*.jsonl"), recursive=True)


def _snapshot(cfg):
    snap = {}
    for f in _transcripts(cfg):
        try:
            snap[f] = os.path.getsize(f)
        except OSError:
            pass
    return snap


def _usage_key(d):
    """Claude Code repeats the SAME message.usage on every content-block line of
    one assistant message, so per-line sums over-count ~2x. Dedupe on
    message.id (fallback requestId); None = no id, count the line once."""
    return (d.get("message") or {}).get("id") or d.get("requestId") or None


def _output_of(d):
    try:
        return int(((d.get("message") or {}).get("usage") or {}).get("output_tokens", 0) or 0)
    except (ValueError, TypeError):
        return 0


def _sum_output_tokens(fh):
    """Sum output_tokens, keeping the LAST line per message id."""
    by_id, total = {}, 0
    for line in fh:
        if '"output_tokens"' not in line:
            continue
        try:
            d = json.loads(line)
        except (ValueError, TypeError):
            continue
        k = _usage_key(d)
        if k is None:
            total += _output_of(d)
        else:
            by_id[k] = _output_of(d)
    return total + sum(by_id.values())


def _delta(cfg, snapfile):
    try:
        with open(snapfile, encoding="utf-8") as fh:
            snap = json.load(fh)
    except (OSError, ValueError):
        snap = {}
    total = 0
    for f in _transcripts(cfg):
        start = int(snap.get(f, 0) or 0)
        try:
            with open(f, encoding="utf-8", errors="ignore") as fh:
                fh.seek(start)          # parse only bytes appended during this session
                total += _sum_output_tokens(fh)
        except OSError:
            pass
    return total


# ── reconcile ────────────────────────────────────────────────────────────────
def _read_int(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return int((fh.read().strip() or "0").split()[0])
    except (OSError, ValueError, IndexError):
        return 0


def _sydney_keys_and_bounds(now_iso=None):
    """(day_key, week_key, day_start_iso, week_start_iso, end_iso) using the same
    Sydney-local boundaries as pace_day()/pace_week() and pool_capacity_drift.py.
    Falls back to UTC when zoneinfo/tzdata is unavailable."""
    from datetime import datetime, timedelta, timezone
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo("Australia/Sydney")
    except Exception:
        tz = timezone.utc
    if now_iso:
        end = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
    else:
        end = datetime.now(timezone.utc)
    local = end.astimezone(tz)
    day_start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = day_start - timedelta(days=local.isoweekday() - 1)
    fmt = lambda d: d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    iso_year, iso_week, _ = local.isocalendar()
    return (local.strftime("%Y%m%d"), "%04d-W%02d" % (iso_year, iso_week),
            fmt(day_start), fmt(week_start), fmt(end))


def _sum_windows(cfg, day_start, week_start, end):
    """One pass over every transcript: (day_total, week_total) of
    message.usage.output_tokens for lines whose top-level timestamp falls in
    [day_start, end) / [week_start, end). Lexicographic compare is safe: Claude
    Code emits fixed-width zero-padded UTC ISO-8601 with a Z suffix."""
    day_total = week_total = 0
    by_id = {}      # message id → (ts, output) — last line wins (see _usage_key)
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
                    if not isinstance(ts, str) or not (week_start <= ts < end):
                        continue
                    n = _output_of(d)
                    k = _usage_key(d)
                    if k is not None:
                        by_id[k] = (ts, n)
                        continue
                    week_total += n
                    if ts >= day_start:
                        day_total += n
        except OSError:
            pass
    for ts, n in by_id.values():
        week_total += n
        if ts >= day_start:
            day_total += n
    return day_total, week_total


def _reconcile(cfg, ledger, now_iso=None):
    day_key, week_key, day_start, week_start, end = _sydney_keys_and_bounds(now_iso)
    day_actual, week_actual = _sum_windows(cfg, day_start, week_start, end)
    os.makedirs(ledger, exist_ok=True)
    lines = []
    for label, key, actual_raw in (("day", day_key, day_actual), ("week", week_key, week_actual)):
        tok_path = os.path.join(ledger, "tok-" + key)
        recorded = _read_int(tok_path)
        apicredit = _read_int(os.path.join(ledger, "apicredit-tok-" + key))
        actual = max(0, actual_raw - apicredit)
        added = 0
        if actual > recorded:
            added = actual - recorded
            tmp = tok_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write("%d\n" % actual)
            os.replace(tmp, tok_path)
        side = {"window": label, "key": key, "recordedBefore": recorded, "transcriptTotal": actual_raw,
                "apicreditExcluded": apicredit, "poolActual": actual, "added": added,
                "ledgerAfter": max(recorded, actual), "windowStart": day_start if label == "day" else week_start,
                "windowEnd": end, "configDir": cfg}
        try:
            with open(tok_path + ".reconcile.json", "w", encoding="utf-8") as fh:
                json.dump(side, fh, indent=2)
        except OSError:
            pass
        lines.append("reconcile %s key=%s recorded=%d actual=%d apicredit=%d added=%d ledger=%d"
                     % (label, key, recorded, actual, apicredit, added, max(recorded, actual)))
    return lines


def main(argv):
    if len(argv) >= 3 and argv[1] == "snapshot":
        print(json.dumps(_snapshot(argv[2])))
        return 0
    if len(argv) >= 4 and argv[1] == "delta":
        print(_delta(argv[2], argv[3]))
        return 0
    if len(argv) >= 4 and argv[1] == "reconcile":
        for line in _reconcile(argv[2], argv[3], argv[4] if len(argv) >= 5 else None):
            print(line)
        return 0
    print(0)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception:
        print(0)
        sys.exit(0)
