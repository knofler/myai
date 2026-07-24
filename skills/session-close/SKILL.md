---
name: session-close
description: "Close a work session by summarizing accomplishments, updating state/STATE.md, writing handoff context to state/AI_AGENT_HANDOFF.md, and logging to logs/claude_log.md. Triggers: end session, session close, wrap up, save state, handoff"
---

# Session Close

Wrap up the current work session and persist all context.

## Playbook

### 1. Summarize Accomplishments

- List everything completed in this session.
- List anything started but not finished.
- Note any decisions made or direction changes.

### 2. Update state/STATE.md

- Open `AI/state/STATE.md`.
- Move completed items to the done section.
- Update in-progress items with current status.
- Add any new items discovered during the session.
- Update the `Last Updated` timestamp.

### 3. Update state/AI_AGENT_HANDOFF.md — a TRIMMED DELTA, not a full rewrite (TOKEN-OPT 3)

> **The brain atom (`wrap up` step 1e) is the PRIMARY continuity record** — the full session
> narrative lives there and every next session boots it via `brain_delta`. This handoff file is
> now only the offline / any-device **fallback**. So write it thin: a delta, not a fresh essay.

- Open `AI/state/AI_AGENT_HANDOFF.md`.
- Update the `Last machine:` field with the current hostname (`hostname -s`).
- Update the header `Brain: <sha>` line with the anchor returned by `brain_sync_verify.sh`
  (written in `wrap up` step 1e — this is the next session's `brain_delta` anchor).
- Update the **`ACTION for next agent`** block — the single most important field: what to do next.
- **Prepend ONE new session summary line** (2–4 sentences: what shipped / decisions / next / blockers)
  and keep **only the top-3** most-recent session lines inline. Do NOT re-emit older lines — leave
  them for `rotate_state.sh` (TOKEN-OPT 1) to archive to `state/archive/handoff-YYYY-MM.md`.
- Result target: header + ACTION + top-3 lines (a few KB), never the full ~28k-token history.
- Everything the delta omits is recoverable from the brain (`brain_delta` / `brain log`) and the
  handoff archive — so the trim loses nothing, it just stops paying to re-read history every boot.
- **User-owed blockers — reference, don't retype:** if this session is blocked on a credential
  or a decision only the operator can supply (an API key, a provisioning step, a billing/licensing
  call), do **not** restate it in the handoff prose. Add/update one row in the master repo's
  `config/user_blockers.md` via `./scripts/user_blockers.sh add <repo> "<blocker>" ["<notes>"]`
  (managed repos: `./AI/scripts/user_blockers.sh`, or edit the master's copy directly), then just
  point the handoff at it (e.g. "blocked — see config/user_blockers.md #<id>"). This keeps one
  canonical fleet-wide list instead of every repo's handoff re-listing the same asks verbatim and
  drifting out of sync. When the operator supplies it, resolve with
  `./scripts/user_blockers.sh resolve <id>`. The dashboard's `/work` → "Blockers" tab renders the
  current list read-only.

### 4. Log to logs/claude_log.md

Append an entry to `logs/claude_log.md`:

```
## [YYYY-MM-DD HH:MM] — Session Close

### Completed
- ...

### In Progress
- ...

### Next Session
- ...

### Decisions
- ...
```

### 5. SONA Pattern Training

Run end-of-session pattern training:

- **Score reused patterns**: For each pattern from SONA context that was used this session:
  - If it helped: `source memory/lib/sona.sh && sona_score_pattern <id> success`
  - If it didn't apply: `source memory/lib/sona.sh && sona_score_pattern <id> failure`
- **Extract new patterns**: For any non-obvious technique or lesson learned:
  - Create pattern JSON following `memory/patterns/SCHEMA.md` format
  - Save via: `source memory/lib/sona.sh && sona_extract_pattern '<json>'`
  - Good candidates: debugging breakthroughs, configuration gotchas, workflow improvements
- **Prune if needed** (every ~10 sessions): `source memory/lib/sona.sh && sona_prune`
- **Stats**: `source memory/lib/sona.sh && sona_stats`

The Stop hook (`hooks/stop/02-sona-session-train.sh`) will also remind about this step.

### 6. Re-embed state into RAG

After STATE.md / AI_AGENT_HANDOFF.md are written, call `memory_reindex` via the MCP gateway so the new session block is searchable through `memory_search` immediately. Best-effort — failure is non-fatal (file write is the source of truth; rotation guard re-runs it on next `agent mode` anyway).

```bash
curl -sf -X POST http://localhost:3100/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_reindex","arguments":{"scope":"master"}}}' \
  | jq -r '.result.content[0].text // "memory_reindex skipped (gateway down)"' \
  || echo "memory_reindex skipped (gateway unreachable)"
```

Expected: `totals.stored` counts the freshly-added chunks (typically 1–2 — the new session block + handoff change). Idempotent via content-hash dedup, so reruns are safe.

### 7. Final Checks

- Verify state/STATE.md was saved successfully.
- Verify state/AI_AGENT_HANDOFF.md was saved successfully.
- Verify logs/claude_log.md was appended to (not overwritten).
- Confirm to the user that state has been persisted.

### 8. Output

Present a brief summary to the user:

```
Session closed. State saved.

**Done this session:**
- ...

**Next session should start with:**
- ...
```
