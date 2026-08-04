#!/usr/bin/env python3
"""retrieval_bandit.py — BRAIN B-7 contextual bandit over RETRIEVAL CONFIG.

This is the plan's EXPLICIT "start here" for self-improving retrieval
(BRAIN_BUILD_PLAN.md §4 B-7 + §6 sequencing): *offline replay + contextual
bandits over retrieval actions only — "most of the value, far less chaos."*

WHAT THIS IS  — a contextual bandit that tunes the RETRIEVAL CONFIG a live
retriever should use (how many candidates to fetch, whether to rerank). The
"arms" are discrete retrieval configs; the bandit learns, per query context,
which config would have surfaced the right document cheapest, driven purely by
OFFLINE REPLAY of the spike's harvested traces
(runtime/route-distill-spike/traces/traces.jsonl).

WHAT THIS IS NOT  — this is emphatically NOT model training. No LoRA, no
fine-tuning, no RL-over-agent-behavior. That whole class of work stays GATED
per B-7.1 (needs >=500 harvested traces AND a local fine-tune toolchain like
mlx-lm — the spike confirmed NEITHER is present, so no adapter was trained and
none promoted). The bandit only ever manipulates retrieval metadata (k, rerank
on/off, ranks, token counts) — never fact content, never behavior. Distill
SKILL/ROUTING/CONFIG, never facts (the B-7 hard constraint).

DESIGN
  Arms      discrete retrieval configs = {k in [3,5,10,20]} x {rerank_on in
            [false,true]} — a small explicit 8-cell grid, deliberately simple.
  Context   coarse query features: a length bucket (token count) x a code-ish
            vs memory-ish flag. A contextual bandit here == one independent
            bandit per context bucket (stats keyed by (context, arm)).
  Policy    epsilon-greedy (epsilon default 0.1), made deterministic by a
            seeded random.Random(seed) — NO unseeded/global RNG. Unpulled arms
            are played once first (standard warm-up) so every arm is measured.
  Reward    per the plan's retrieval-only reward sketch: +1 if the chosen arm's
            simulated retrieval would surface the correct doc at RANK 1
            (route@1 hit), minus small penalties for n_fetches and frontier
            tokens. Reward is computed by REPLAYING each trace through a simple
            token-overlap retrieval simulation at the candidate arm (same
            keyword-overlap spirit as the spike baseline — the point is the
            bandit machinery + offline tuning loop, not a perfect retriever).

PERSISTENCE
  Arm statistics live in the shared repo-index SQLite DB, table `bandit_arms`
  (context TEXT, arm TEXT, pulls INT, reward_sum REAL, PK(context, arm)) — see
  scripts/lib/repo_index_schema.py. replay_tune() starts each offline pass from
  a clean slate (one self-contained experiment => deterministic given a seed).

PUBLIC INTERFACE
  select_arm(conn, context) -> dict        epsilon-greedy policy (used online)
  update(conn, context, arm, reward) -> None   persist one pull + reward
  best_arm(conn, context) -> dict | None   pure argmax-exploit recommendation
  replay_tune(traces_path, db_path, seed=0) -> dict   run the offline pass,
            return the winning (recommended) config per context + metrics.
  bandit_snapshot(conn) -> dict            READ-ONLY view of bandit_arms as it
            currently stands (never mutates) — "which arm is favored right
            now, per context" for operator-facing surfaces (the dashboard's
            /brain Retrieval strategy card), as opposed to replay_tune which
            wipes and re-runs the table as one offline experiment.

CLI
  retrieval_bandit.py [--db PATH] [--traces PATH] [--seed 0] [--json]
  Runs replay_tune and prints the recommended retrieval config per context.
  retrieval_bandit.py [--db PATH] --summary [--json]
  Prints bandit_snapshot() instead — the live table as-is, no replay.

  The recommended config is what the LIVE retriever (B-4 hybrid retrieval /
  B-3 router) SHOULD adopt. Wiring it into the live loop is a FOLLOW-UP once a
  live route_eval log exists — the spike notes that the verbatim dispatch query
  handed to a fleet task is not persisted anywhere reachable yet (only the
  RESULT tail survives), so this tunes against harvested RESULT-proxy traces.

If the traces file is absent or empty, this exits cleanly reporting
"no traces — nothing to tune" (same posture as the spike gates).
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "lib"))
from repo_index_schema import connect, tokenize  # noqa: E402

# ── the arm grid (discrete retrieval configs) ────────────────────────────────
K_VALUES = [3, 5, 10, 20]
RERANK_VALUES = [False, True]
# canonical, deterministic arm order (k ascending, rerank False before True)
ARMS: list[dict] = [{"k": k, "rerank_on": r} for r in RERANK_VALUES for k in K_VALUES]
ARMS.sort(key=lambda a: (a["k"], a["rerank_on"]))

# ── reward weights (route@1 hit must dominate; penalties only break ties) ────
LAMBDA_FETCH = 0.01      # per fetched candidate
LAMBDA_TOKENS = 0.00001  # per frontier input token (top-3 fetched docs)
NOMINAL_DOC_TOKENS = 400  # per-doc token estimate when a trace carries no size

# ── policy ───────────────────────────────────────────────────────────────────
EPSILON = 0.1
POLICY = "epsilon-greedy"

# Module RNG. Seeded by replay_tune()/select_seed() so behavior is deterministic
# given a seed. NEVER use the unseeded global random module directly.
_RNG = random.Random(0)


def set_seed(seed: int) -> None:
    """Reseed the module RNG so epsilon-greedy selection is deterministic."""
    global _RNG
    _RNG = random.Random(seed)


# ── arm (de)serialization ─────────────────────────────────────────────────────
def _arm_key(arm) -> str:
    """Canonical TEXT key for the bandit_arms.arm column."""
    if isinstance(arm, str):
        return arm
    return json.dumps({"k": int(arm["k"]), "rerank_on": bool(arm["rerank_on"])}, sort_keys=True)


def _arm_dict(arm) -> dict:
    if isinstance(arm, dict):
        return {"k": int(arm["k"]), "rerank_on": bool(arm["rerank_on"])}
    d = json.loads(arm)
    return {"k": int(d["k"]), "rerank_on": bool(d["rerank_on"])}


_ARM_KEYS = [_arm_key(a) for a in ARMS]


# ── context featurization (coarse query features) ────────────────────────────
_CODE_HINTS = {
    "function", "class", "def", "import", "const", "interface", "enum", "type",
    "route", "endpoint", "schema", "test", "fix", "refactor", "bug", "impl",
    "ts", "tsx", "py", "js", "mjs", "sh", "json", "sql", "yaml", "yml",
}
_MEM_HINTS = {
    "session", "handoff", "state", "remember", "recall", "brain", "atom",
    "decision", "plan", "note", "meeting", "who", "owe", "context", "history",
}


def query_context(query: str) -> str:
    """Map a query to a coarse context bucket: '<len>:<kind>'.

    len : s (<64 tokens), m (<256), l (>=256) — cheap query-size proxy.
    kind: 'code' if the query reads code-ish, else 'mem' (memory/NL-ish).
    A contextual bandit == one independent bandit per returned bucket string.
    """
    toks = tokenize(query or "")
    n = len(toks)
    length = "s" if n < 64 else ("m" if n < 256 else "l")
    tset = set(toks)
    code_score = len(tset & _CODE_HINTS)
    mem_score = len(tset & _MEM_HINTS)
    kind = "code" if code_score >= mem_score else "mem"
    return f"{length}:{kind}"


# ── retrieval simulation (token-overlap, spike-baseline spirit) ──────────────
def _overlap(qtokens: set, path: str) -> int:
    return len(qtokens & set(tokenize(path)))


def _simulate_retrieval(query: str, candidates: list, k: int, rerank_on: bool) -> list:
    """Return the ranked candidate list the arm (k, rerank_on) would produce.

    Fetch the top-k of the (already baseline-ranked) candidates; if rerank_on,
    reorder that window by token-overlap with the query (stable: ties keep the
    incoming order). A doc can only be a route@1 hit if it lands first here.
    """
    window = list(candidates[:k])
    if rerank_on:
        qtokens = set(tokenize(query or ""))
        order = sorted(range(len(window)), key=lambda i: (-_overlap(qtokens, window[i]), i))
        window = [window[i] for i in order]
    return window


def _doc_tokens(cand: str, trace: dict) -> int:
    sizes = trace.get("cand_tokens")
    if isinstance(sizes, dict) and cand in sizes:
        try:
            return int(sizes[cand])
        except (TypeError, ValueError):
            pass
    return NOMINAL_DOC_TOKENS


def compute_reward(trace: dict, arm) -> float:
    """Replay one trace at one arm and score it per the B-7 reward sketch.

    reward = route@1_hit(1/0) - LAMBDA_FETCH * n_fetches
             - LAMBDA_TOKENS * frontier_input_tokens(top-3 fetched)
    """
    arm = _arm_dict(arm)
    candidates = list(trace.get("candidates") or [])
    chosen = set(trace.get("chosen") or [])
    ranked = _simulate_retrieval(trace.get("query", ""), candidates, arm["k"], arm["rerank_on"])

    hit = 1.0 if (ranked and ranked[0] in chosen) else 0.0
    n_fetches = min(arm["k"], len(candidates))
    frontier_tokens = sum(_doc_tokens(c, trace) for c in ranked[:3])
    return hit - LAMBDA_FETCH * n_fetches - LAMBDA_TOKENS * frontier_tokens


# ── persistence-backed bandit primitives ──────────────────────────────────────
def _load_stats(conn, context: str) -> dict:
    rows = conn.execute(
        "SELECT arm, pulls, reward_sum FROM bandit_arms WHERE context = ?", (context,)
    ).fetchall()
    return {arm: (int(pulls), float(rsum)) for arm, pulls, rsum in rows}


def _mean(pulls: int, reward_sum: float) -> float:
    return reward_sum / pulls if pulls > 0 else 0.0


def _argmax_pulled(stats: dict):
    """Best arm key among arms with pulls > 0 (ties -> canonical order), or None.

    Restricting to pulled arms matters: an unpulled arm's mean is 0.0, which
    would otherwise beat a genuinely-measured arm whose reward is negative, and
    we'd 'recommend' something we never actually evaluated.
    """
    pulled = [key for key in _ARM_KEYS if stats.get(key, (0, 0.0))[0] > 0]
    if not pulled:
        return None
    return max(pulled, key=lambda key: (_mean(*stats[key]), -_ARM_KEYS.index(key)))


def select_arm(conn, context: str) -> dict:
    """Epsilon-greedy arm choice for a context (the online policy).

    Deterministic given the seed set via set_seed()/replay_tune(): any
    never-pulled arm is played first (canonical order), then with probability
    EPSILON explore a uniformly-random arm, else exploit the best mean reward
    (ties broken by canonical arm order).
    """
    stats = _load_stats(conn, context)
    for key in _ARM_KEYS:  # warm-up: play each arm once, canonical order
        if stats.get(key, (0, 0.0))[0] == 0:
            return _arm_dict(key)

    if _RNG.random() < EPSILON:
        return _arm_dict(_RNG.choice(_ARM_KEYS))

    best_key = _argmax_pulled(stats) or _ARM_KEYS[0]
    return _arm_dict(best_key)


def update(conn, context: str, arm, reward: float) -> None:
    """Record one pull of `arm` in `context` with `reward` (accumulating)."""
    conn.execute(
        "INSERT INTO bandit_arms(context, arm, pulls, reward_sum) VALUES (?, ?, 1, ?) "
        "ON CONFLICT(context, arm) DO UPDATE SET "
        "pulls = pulls + 1, reward_sum = reward_sum + excluded.reward_sum",
        (context, _arm_key(arm), float(reward)),
    )
    conn.commit()


def best_arm(conn, context: str):
    """Pure argmax-exploit recommendation for a context (no exploration).

    Returns the arm dict with the highest mean reward, or None if the context
    has no recorded pulls yet. Ties broken by canonical arm order (stable).
    """
    best_key = _argmax_pulled(_load_stats(conn, context))
    return _arm_dict(best_key) if best_key else None


def bandit_snapshot(conn) -> dict:
    """Read-only snapshot of `bandit_arms` exactly as currently persisted.

    Unlike replay_tune() (which DELETEs bandit_arms and re-runs a clean
    offline pass), this never mutates the table — it just reports which arm
    each context currently favors (best_arm's argmax-exploit pick) alongside
    the per-arm pull/reward stats backing that pick. Used by brain_route.py's
    dashboard-facing summary (BRAIN B-7 follow-up) so an operator can see the
    live bandit state without reading raw SQL.
    """
    rows = conn.execute(
        "SELECT context, arm, pulls, reward_sum FROM bandit_arms ORDER BY context, arm"
    ).fetchall()
    by_context: dict = {}
    for context, arm, pulls, reward_sum in rows:
        by_context.setdefault(context, {})[arm] = (int(pulls), float(reward_sum))

    contexts = []
    for ctx in sorted(by_context):
        stats = by_context[ctx]
        arms_out = [
            {
                "arm": arm_key,
                **_arm_dict(arm_key),  # k, rerank_on — decoded so callers never re-parse the TEXT key
                "pulls": pulls,
                "reward_sum": round(rsum, 6),
                "mean_reward": round(_mean(pulls, rsum), 6),
            }
            for arm_key, (pulls, rsum) in sorted(stats.items())
        ]
        contexts.append({
            "context": ctx,
            "favored_arm": best_arm(conn, ctx),
            "pulls_total": sum(a["pulls"] for a in arms_out),
            "arms": arms_out,
        })

    return {
        "total_pulls": sum(c["pulls_total"] for c in contexts),
        "contexts": contexts,
    }


# ── offline replay / tuning loop ──────────────────────────────────────────────
def load_traces(traces_path: str) -> list:
    if not traces_path or not os.path.exists(traces_path):
        return []
    out = []
    with open(traces_path) as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def replay_tune(traces_path: str, db_path: str, seed: int = 0) -> dict:
    """Run the offline-replay tuning pass and return the recommended config.

    For each trace (processed in a deterministic chronological order): featurize
    the query into a context, let the epsilon-greedy policy pick an arm, replay
    the trace at that arm to compute the reward, and persist the pull. Each call
    starts from a clean bandit_arms table so the pass is a self-contained,
    seed-deterministic experiment.

    Returns a summary dict: recommended arm per context, per-context arm stats,
    and the aggregate metrics of the recommended configs.
    """
    traces = load_traces(traces_path)
    if not traces:
        return {"traces": 0, "message": "no traces — nothing to tune"}

    set_seed(seed)
    conn = connect(db_path)
    conn.execute("DELETE FROM bandit_arms")  # clean slate => deterministic pass
    conn.commit()

    # deterministic order (chronological, tie-broken by task_id)
    traces.sort(key=lambda t: (t.get("written_at", 0), str(t.get("task_id", ""))))

    contexts_seen = set()
    for t in traces:
        ctx = query_context(t.get("query", ""))
        contexts_seen.add(ctx)
        arm = select_arm(conn, ctx)
        reward = compute_reward(t, arm)
        update(conn, ctx, arm, reward)

    contexts: dict = {}
    recommended: dict = {}
    for ctx in sorted(contexts_seen):
        stats = _load_stats(conn, ctx)
        arms_out = {}
        for key in _ARM_KEYS:
            pulls, rsum = stats.get(key, (0, 0.0))
            if pulls == 0:
                continue
            arms_out[key] = {
                "pulls": pulls,
                "reward_sum": round(rsum, 6),
                "mean": round(_mean(pulls, rsum), 6),
            }
        rec = best_arm(conn, ctx)
        recommended[ctx] = rec
        best_key = _arm_key(rec) if rec else None
        contexts[ctx] = {
            "best_arm": rec,
            "best_mean_reward": arms_out.get(best_key, {}).get("mean") if best_key else None,
            "pulls_total": sum(v["pulls"] for v in arms_out.values()),
            "arms": arms_out,
        }

    total_pulls = conn.execute("SELECT COALESCE(SUM(pulls), 0) FROM bandit_arms").fetchone()[0]
    conn.close()

    return {
        "traces": len(traces),
        "seed": seed,
        "policy": POLICY,
        "epsilon": EPSILON,
        "arms_grid": ARMS,
        "total_pulls": int(total_pulls),
        "contexts": contexts,
        "recommended": recommended,
    }


# ── CLI ────────────────────────────────────────────────────────────────────────
def _default_traces() -> str:
    return os.path.join(
        os.path.dirname(__file__), "..", "runtime", "route-distill-spike", "traces", "traces.jsonl"
    )


def _default_db() -> str:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    return os.path.join(root, "state", ".repo_index.sqlite3")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="BRAIN B-7 contextual bandit over retrieval config.")
    p.add_argument("--db", default=None, help="repo-index SQLite DB (default: state/.repo_index.sqlite3)")
    p.add_argument("--traces", default=None, help="traces.jsonl (default: route-distill-spike traces)")
    p.add_argument("--seed", type=int, default=0, help="RNG seed for deterministic replay (default 0)")
    p.add_argument("--json", action="store_true", help="emit the full summary as JSON")
    p.add_argument("--summary", action="store_true",
                    help="print bandit_snapshot() (read-only, no replay) instead of running replay_tune")
    args = p.parse_args(argv)

    db_path = args.db or _default_db()
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)

    if args.summary:
        conn = connect(db_path)
        snap = bandit_snapshot(conn)
        conn.close()
        print(json.dumps(snap, indent=2))
        return 0

    traces_path = args.traces or _default_traces()
    result = replay_tune(traces_path, db_path, seed=args.seed)

    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    if result.get("traces", 0) == 0:
        print(result.get("message", "no traces — nothing to tune"))
        return 0

    print(f"retrieval_bandit: offline-replay over {result['traces']} traces "
          f"(policy={result['policy']}, epsilon={result['epsilon']}, seed={result['seed']})")
    print("recommended retrieval config per query context "
          "(what the live B-4/B-3 retriever SHOULD adopt):")
    for ctx in sorted(result["recommended"]):
        rec = result["recommended"][ctx]
        cinfo = result["contexts"][ctx]
        if rec is None:
            print(f"  {ctx:<10}  (no data)")
            continue
        print(f"  {ctx:<10}  k={rec['k']:<3} rerank={'on' if rec['rerank_on'] else 'off':<3}  "
              f"mean_reward={cinfo['best_mean_reward']}  pulls={cinfo['pulls_total']}")
    print("note: wiring this into the live retrieval loop is a follow-up — needs a "
          "persisted live route_eval log (dispatch-query logging not yet persisted).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
