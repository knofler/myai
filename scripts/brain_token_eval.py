#!/usr/bin/env python3
# =============================================================================
# brain_token_eval.py — MEASURE the brain's cold-start token savings (BRAIN_BUILD_PLAN §0).
#
# The whole brain thesis is a NUMBER: "you boot for ~a few hundred tokens, not
# tens of thousands, because you read a tiny compiled brief + only-what-changed
# instead of re-reading STATE.md + the handoff every session." This proves it
# with real files, one estimator applied to BOTH sides (fair ratio even if the
# absolute token count is approximate).
#
# Two comparisons:
#   1. COLD START (blank agent)     OLD = read STATE.md + AI_AGENT_HANDOFF.md in full
#                                   NEW = read the compiled brain brief only
#   2. RETURNING agent (per session) OLD = re-read STATE.md + handoff AGAIN (every start)
#                                   NEW = brain_delta since last-seen SHA (only the diff)
#
# Token estimate: tiktoken/cl100k if importable (close enough for a ratio), else
# a calibrated chars/4 fallback. The METHOD is identical on both sides, so the
# reduction % is honest regardless of which estimator is used.
#
#   scripts/brain_token_eval.py [--namespace ai-management] [--since <sha>] [--json]
#
# Env: MYAI_BRAIN_DIR (default ~/.myai/brain), GATEWAY_MCP, GATEWAY_LOCAL_TOKEN.
# =============================================================================
from __future__ import annotations
import argparse, json, os, sys, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def est_tokens(text: str) -> int:
    try:
        import tiktoken
        return len(tiktoken.get_encoding("cl100k_base").encode(text))
    except Exception:
        # calibrated fallback: English prose/code averages ~4 chars/token
        return max(1, round(len(text) / 4))


def estimator_name() -> str:
    try:
        import tiktoken  # noqa: F401
        return "tiktoken/cl100k_base"
    except Exception:
        return "chars/4 (approx — install tiktoken for exact)"


def read(p: Path) -> str:
    try:
        return p.read_text(errors="replace")
    except Exception:
        return ""


def brain_dir() -> Path:
    return Path(os.environ.get("MYAI_BRAIN_DIR", str(Path.home() / ".myai" / "brain")))


def brain_delta_tokens(since: str | None) -> tuple[int, str]:
    """Ask the gateway for the brain_delta payload token estimate; fall back to
    the local working.md if the gateway is unreachable."""
    if not since:
        return -1, "no --since given"
    tok = os.environ.get("GATEWAY_LOCAL_TOKEN", "")
    mcp = os.environ.get("GATEWAY_MCP", "http://localhost:3100/mcp")
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "brain_delta", "arguments": {"since": since}},
    })
    try:
        out = subprocess.run(
            ["curl", "-sf", "-m", "8", "-X", "POST", mcp,
             "-H", "content-type: application/json",
             "-H", f"x-gateway-local-token: {tok}", "-d", payload],
            capture_output=True, text=True, timeout=12,
        ).stdout
        body = json.loads(json.loads(out)["result"]["content"][0]["text"])
        if body.get("upToDate"):
            return 0, "brain_delta: up-to-date (0 new)"
        # prefer the gateway's own estimate; else estimate the commit subjects
        if isinstance(body.get("tokenEstimate"), int):
            return body["tokenEstimate"], "brain_delta.tokenEstimate (gateway)"
        return est_tokens(json.dumps(body.get("commits", []))), "brain_delta commits (estimated)"
    except Exception as e:
        return -1, f"gateway unreachable ({type(e).__name__})"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--namespace", default="ai-management")
    ap.add_argument("--since", default=None, help="last-seen brain SHA for the returning-agent case")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    # OLD boot corpus — what a fresh session reads today (hot-tier state).
    old_files = [ROOT / "state" / "STATE.md", ROOT / "state" / "AI_AGENT_HANDOFF.md"]
    old_txt = "\n".join(read(f) for f in old_files)
    old_tok = est_tokens(old_txt)

    # NEW cold boot — the compiled brief only.
    ns = brain_dir() / "repos" / a.namespace
    brief = ns / "brief.md"
    brief_tok = est_tokens(read(brief)) if brief.exists() else -1
    working = ns / "working.md"
    working_tok = est_tokens(read(working)) if working.exists() else -1

    # NEW returning boot — brain_delta since last SHA.
    delta_tok, delta_note = brain_delta_tokens(a.since)

    def pct(old: int, new: int) -> float:
        return round(100 * (1 - new / old), 1) if old > 0 and new >= 0 else float("nan")

    def ratio(old: int, new: int) -> str:
        return f"{old / new:.1f}x" if new and new > 0 else "n/a"

    result = {
        "estimator": estimator_name(),
        "namespace": a.namespace,
        "old_boot": {"files": [str(f.relative_to(ROOT)) for f in old_files], "tokens": old_tok},
        "cold_start": {"new_tokens": brief_tok, "reduction_pct": pct(old_tok, brief_tok), "ratio": ratio(old_tok, brief_tok)},
        "returning": {"new_tokens": delta_tok, "note": delta_note,
                      "reduction_pct": pct(old_tok, delta_tok) if delta_tok >= 0 else None,
                      "ratio": ratio(old_tok, delta_tok) if delta_tok > 0 else "n/a"},
        "working_set": {"tokens": working_tok, "note": "brief+working loaded for a full-context session"},
    }

    if a.json:
        print(json.dumps(result, indent=2))
        return 0

    def fmt(n: int) -> str:
        return f"{n:,}" if n >= 0 else "n/a"

    print("=" * 62)
    print(f"  BRAIN COLD-START TOKEN EVAL  ·  ns={a.namespace}")
    print(f"  estimator: {estimator_name()}")
    print("=" * 62)
    print(f"  OLD boot (read STATE.md + handoff, every session): {fmt(old_tok):>8} tok")
    print("  " + "-" * 58)
    print(f"  NEW cold start  (compiled brief.md)              : {fmt(brief_tok):>8} tok"
          f"   → {result['cold_start']['reduction_pct']}% less  ({result['cold_start']['ratio']})")
    if delta_tok >= 0:
        print(f"  NEW returning   (brain_delta since {str(a.since)[:7]})       : {fmt(delta_tok):>8} tok"
              f"   → {result['returning']['reduction_pct']}% less  ({result['returning']['ratio']})")
    else:
        print(f"  NEW returning   (brain_delta)                    :      n/a   ({delta_note})")
    print("  " + "-" * 58)
    print(f"  full working set (brief+working, heavy session)  : {fmt(working_tok):>8} tok")
    # SMART returning boot: cap the delta at the compiled working-set size — after a
    # long absence, re-reading working.md beats replaying a bloated delta.
    if brief_tok >= 0 and working_tok >= 0:
        capped = min(delta_tok, working_tok) if delta_tok >= 0 else working_tok
        smart = brief_tok + capped
        result["smart_returning"] = {"tokens": smart, "reduction_pct": pct(old_tok, smart),
                                     "ratio": ratio(old_tok, smart),
                                     "rule": "brief + min(delta, working)"}
        via = "delta" if delta_tok >= 0 and delta_tok <= working_tok else "working (delta bloated)"
        print(f"  SMART returning (brief + min(delta,working))     : {fmt(smart):>8} tok"
              f"   → {result['smart_returning']['reduction_pct']}% less  ({result['smart_returning']['ratio']})  [via {via}]")
    print("=" * 62)
    if brief_tok >= 0 and old_tok > 0:
        print(f"  ⇒ A blank agent boots knowing this project for ~{brief_tok} tokens")
        print(f"    instead of ~{old_tok:,} — {result['cold_start']['ratio']} cheaper, every single start.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
