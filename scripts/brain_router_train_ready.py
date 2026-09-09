#!/usr/bin/env python3
"""brain_router_train_ready.py — BRAIN B-7.1 readiness gate for LoRA router
training (BRAIN_BUILD_PLAN.md §6 / B-7.1: "LoRA router training needs >=500
traces and must stay a GATED, never-forced upgrade").

WHAT THIS BUILDS  — the concrete missing piece flagged by the B-7.1 spike and
the B-7 live-wiring follow-up: a trace-COLLECTION store that piggybacks on
the retrieval bandit's already-live decision log (`route_eval`, written by
scripts/brain_route.py's route() on every dispatch — see _log_route_eval),
plus a readiness check that reports the labeled-trace count against the
placeholder threshold train_router_lora.py already gates on.

WHAT COUNTS AS A "LABELED" TRACE  — a route_eval row (or harvested spike
trace) whose `chosen` field is non-null. `chosen` IS the supervised target
target-(a) router training needs (route prediction: JSON
{store,namespace,repo,atom_id,confidence}, per train_router_lora.py's
docstring) — a row where retrieval never narrowed to a clear top-1 has no
label to learn from, so it does not count toward the threshold.

TWO SOURCES, SUMMED  — same posture as train_router_lora.py's own MIN_TRACES
gate, just no longer limited to the one-time harvest:
  1. LIVE  — route_eval rows accumulated by every real brain_route.py
     dispatch (grows automatically as the fleet runs more tasks; this is
     "the retrieval bandit's logged decisions" this task piggybacks on —
     each row already carries the bandit's k/rerank_on/bandit_used choice
     alongside query/candidates/chosen).
  2. HARVESTED — the B-7.1 spike's one-time pull from brain session history
     x git log (runtime/route-distill-spike/traces/traces.jsonl), kept in
     the count so a repo that already ran the spike doesn't regress to 0.

THIS SCRIPT NEVER TRAINS ANYTHING. It only collects + counts. Training stays
exactly as gated/manual as train_router_lora.py already made it — this is a
readiness *check*, not a trainer. `--export` optionally materializes the
live labeled traces as JSONL (same {query, candidates, chosen, used,
test_pass, correction} shape as the harvested file) so a future training
pass can concatenate both sources; nothing calls that flag automatically.

INGESTION RATE + ETA (task-7fdc970b)  — the report also carries how fast
labeled traces are banking (labeled route_eval rows written in the trailing
`--window-days` window, as traces/day) and the ETA to the 500 floor at that
rate, so the dashboard's /brain readiness panel can show "traces banked /
floor / ETA" without an operator running this script by hand. Rate is
live-only by construction — the harvested spike file is a one-time pull, it
never ingests again. `--now` pins the clock (test hook only).

CLI
  brain_router_train_ready.py [--db PATH] [--spike-traces PATH] [--json]
                              [--window-days N] [--now ISO8601]
  brain_router_train_ready.py --export PATH   also write live labeled
                                               route_eval traces as JSONL
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "lib"))
from repo_index_schema import connect  # noqa: E402

# Mirrors runtime/route-distill-spike/train_router_lora.py's MIN_TRACES. Kept
# as a separate constant (not imported) — the two scripts live in different
# trees (scripts/ vs runtime/route-distill-spike/) with no shared package
# boundary. Still a placeholder floor per that script's own docstring; if one
# changes, change both.
MIN_TRACES = 500

# Trailing window for the ingestion-rate estimate. Two weeks smooths over the
# fleet's bursty runner schedule (a quiet weekend shouldn't read as "ingestion
# stopped") while staying recent enough that an ETA reflects current behavior.
INGESTION_WINDOW_DAYS = 14


def _parse_written_at(ts: str) -> datetime.datetime | None:
    """Parse a route_eval `written_at` stamp to an aware UTC datetime.

    brain_route.py writes tz-aware `isoformat()` (+00:00); older fixtures and
    hand-inserted rows may carry a `Z` suffix or be naive — tolerate all
    three, and return None (row simply doesn't count toward the rate) for
    anything unparseable rather than failing the whole report.
    """
    if not ts:
        return None
    try:
        dt = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def count_recent_live_labeled(conn, now: datetime.datetime, window_days: int) -> int:
    """Labeled route_eval rows written within the trailing window."""
    cutoff = now - datetime.timedelta(days=window_days)
    rows = conn.execute(
        "SELECT written_at FROM route_eval WHERE chosen IS NOT NULL"
    ).fetchall()
    n = 0
    for (written_at,) in rows:
        dt = _parse_written_at(written_at)
        if dt is not None and dt >= cutoff:
            n += 1
    return n


def count_live_labeled(conn) -> int:
    """Labeled route_eval rows: `chosen` is non-null (a resolved top-1)."""
    row = conn.execute(
        "SELECT COUNT(*) FROM route_eval WHERE chosen IS NOT NULL"
    ).fetchone()
    return int(row[0]) if row else 0


def collect_live_labeled_traces(conn) -> list[dict]:
    """Materialize labeled route_eval rows into the harvested-trace shape.

    This is the trace-collection store's read path: turns the bandit's live
    per-dispatch log into rows a future training/replay pass can consume
    without re-deriving anything from route_eval's SQL schema.
    """
    rows = conn.execute(
        "SELECT written_at, query_hash, query, plane, context, k, rerank_on, "
        "bandit_used, candidates, chosen, used, test_pass, correction "
        "FROM route_eval WHERE chosen IS NOT NULL ORDER BY id"
    ).fetchall()
    out = []
    for (written_at, query_hash, query, plane, context, k, rerank_on,
         bandit_used, candidates, chosen, used, test_pass, correction) in rows:
        out.append({
            "source": "route_eval",
            "written_at": written_at,
            "query_hash": query_hash,
            "query": query,
            "plane": plane,
            "context": context,
            "k": k,
            "rerank_on": bool(rerank_on),
            "bandit_used": bool(bandit_used),
            "candidates": json.loads(candidates) if candidates else [],
            "chosen": json.loads(chosen) if chosen else None,
            "used": used,
            "test_pass": test_pass,
            "correction": correction,
        })
    return out


def count_harvested_labeled(traces_path: str) -> int:
    """Labeled rows in the B-7.1 spike's harvested traces.jsonl, if present."""
    if not traces_path or not os.path.exists(traces_path):
        return 0
    n = 0
    with open(traces_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                t = json.loads(line)
            except json.JSONDecodeError:
                continue
            if t.get("chosen"):
                n += 1
    return n


def _default_db() -> str:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    return os.path.join(root, "state", ".repo_index.sqlite3")


def _default_spike_traces() -> str:
    return os.path.join(
        os.path.dirname(__file__), "..", "runtime", "route-distill-spike", "traces", "traces.jsonl"
    )


def train_readiness(
    conn,
    spike_traces_path: str,
    now: datetime.datetime | None = None,
    window_days: int = INGESTION_WINDOW_DAYS,
) -> dict:
    """Count labeled traces (live + harvested) against MIN_TRACES.

    Returns a report dict — never a boolean gate callers should mistake for
    "OK to train": training also needs a local fine-tune toolchain (see
    train_router_lora.py's mlx_lm_available() check), which this script does
    not verify since it never touches the training step.

    The report also carries the trailing-window ingestion rate (labeled LIVE
    rows only — the harvested spike file never grows) and the ETA to the
    floor at that rate: eta_days is 0 when already ready, None when nothing
    labeled landed in the window (rate unknown, extrapolation would be a
    guess), else remaining/per_day.
    """
    now = now or datetime.datetime.now(datetime.timezone.utc)
    live = count_live_labeled(conn)
    harvested = count_harvested_labeled(spike_traces_path)
    total = live + harvested
    ready = total >= MIN_TRACES
    remaining = max(0, MIN_TRACES - total)
    recent = count_recent_live_labeled(conn, now, window_days)
    per_day = recent / window_days if window_days > 0 else 0.0
    if ready:
        eta_days = 0.0
    elif per_day > 0:
        eta_days = round(remaining / per_day, 1)
    else:
        eta_days = None
    estimated_ready_at = (
        (now + datetime.timedelta(days=eta_days)).date().isoformat()
        if eta_days else None
    )
    return {
        "ready": ready,
        "trace_count": total,
        "min_traces_required": MIN_TRACES,
        "traces_remaining": remaining,
        "sources": {
            "live_route_eval_labeled": live,
            "harvested_spike_labeled": harvested,
        },
        "ingestion": {
            "window_days": window_days,
            "recent_labeled": recent,
            "per_day": round(per_day, 3),
        },
        "eta_days": eta_days,
        "estimated_ready_at": estimated_ready_at,
        "training_status": (
            "trace-volume gate met — training remains OFF/manual by default; "
            "run train_router_lora.py by hand, which separately gates on a local "
            "fine-tune toolchain (mlx-lm)"
            if ready else
            "GATED — not enough labeled traces yet; no training run should be "
            "attempted (BRAIN_BUILD_PLAN.md B-7.1)"
        ),
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description="BRAIN B-7.1 readiness gate: count labeled router-training traces vs threshold."
    )
    p.add_argument("--db", default=None, help="repo-index SQLite DB (default: state/.repo_index.sqlite3)")
    p.add_argument("--spike-traces", default=None,
                    help="harvested B-7.1 spike traces.jsonl (default: route-distill-spike/traces/traces.jsonl)")
    p.add_argument("--json", action="store_true", help="emit the report as JSON")
    p.add_argument("--export", default=None,
                    help="also write live labeled route_eval traces as JSONL to this path")
    p.add_argument("--window-days", type=int, default=INGESTION_WINDOW_DAYS,
                    help=f"trailing window for the ingestion-rate estimate (default {INGESTION_WINDOW_DAYS})")
    p.add_argument("--now", default=None,
                    help="pin the clock to this ISO-8601 instant (test hook)")
    args = p.parse_args(argv)

    db_path = args.db or _default_db()
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    spike_traces_path = args.spike_traces or _default_spike_traces()
    now = _parse_written_at(args.now) if args.now else None
    if args.now and now is None:
        p.error(f"--now is not a parseable ISO-8601 instant: {args.now}")

    conn = connect(db_path)
    report = train_readiness(conn, spike_traces_path, now=now, window_days=args.window_days)

    if args.export:
        traces = collect_live_labeled_traces(conn)
        os.makedirs(os.path.dirname(os.path.abspath(args.export)), exist_ok=True)
        with open(args.export, "w") as f:
            for t in traces:
                f.write(json.dumps(t) + "\n")
        report["exported"] = {"path": args.export, "count": len(traces)}

    conn.close()

    if args.json:
        print(json.dumps(report, indent=2))
        return 0

    print(f"brain_router_train_ready: {report['trace_count']}/{report['min_traces_required']} labeled traces "
          f"({'READY' if report['ready'] else 'not ready'})")
    print(f"  live (route_eval, bandit-logged dispatches): {report['sources']['live_route_eval_labeled']}")
    print(f"  harvested (B-7.1 spike traces.jsonl):        {report['sources']['harvested_spike_labeled']}")
    ing = report["ingestion"]
    print(f"  ingestion (last {ing['window_days']}d): {ing['recent_labeled']} labeled (~{ing['per_day']}/day)")
    if report["ready"]:
        print("  ETA: floor already met")
    elif report["eta_days"] is None:
        print("  ETA: unknown — no labeled traces landed in the window")
    else:
        print(f"  ETA: ~{report['eta_days']} days to the {report['min_traces_required']} floor"
              f" ({report['estimated_ready_at']})")
    print(f"  {report['training_status']}")
    if "exported" in report:
        print(f"  exported {report['exported']['count']} live labeled traces -> {report['exported']['path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
