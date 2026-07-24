# SONA — Self-Optimizing Neural Agent

> Cross-session pattern learning for all AI agents. Learns from completed tasks, scores reused patterns, and loads relevant context on session start.

## How It Works

```
Session Start                          Session Close
     │                                       │
     ▼                                       ▼
Load SONA context              Extract new patterns from tasks
  (hook: 08-sona-context-load)    Score reused patterns (+/-)
     │                            Prune low-confidence patterns
     ▼                                       │
Match patterns by tags                       ▼
  from STATE.md topics           Update index + config
     │                                       │
     ▼                                       ▼
Inject top-3 into               Stop hook reminds to train
  agent prompt context             (hook: 02-sona-session-train)
```

## Pattern Store

```
memory/
  patterns/
    SCHEMA.md           ← Schema definition + naming conventions
    index.json          ← Lightweight index (id, title, tags, confidence)
    pat-*.json          ← Full pattern files
  errors/index.json     ← Error patterns to avoid
  preferences/index.json ← User/project preferences
  context/index.json    ← Task context snapshots
  config/
    sona-config.json    ← Learning rate, thresholds, prune rules
    memory-config.json  ← Store backend, retrieval weights
  lib/
    sona.sh             ← Shell library with all SONA operations
```

## Shell Library (`memory/lib/sona.sh`)

Source it and use these functions:

```bash
source memory/lib/sona.sh

# Match patterns by tags (returns JSON array ranked by score)
sona_match_patterns hooks bash deployment --top 5

# Build context for a task (formatted text for agent prompts)
sona_context_for_task docker vercel ci-cd

# Load a full pattern
sona_load_pattern pat-set-plus-e-hooks

# Score a pattern after reuse
sona_score_pattern pat-set-plus-e-hooks success   # +0.05 confidence
sona_score_pattern pat-set-plus-e-hooks failure   # -0.10 confidence

# Extract a new pattern (pass full JSON)
sona_extract_pattern '{"id":"pat-my-pattern","title":"...","tags":["a","b"],...}'

# Rebuild the full index from all pat-*.json files
sona_rebuild_index

# Prune low-confidence and stale patterns
sona_prune

# Show stats
sona_stats
```

## Pattern Lifecycle

```
1. EXTRACT  → Task completed → agent creates pat-*.json (confidence: 0.5)
2. INDEX    → Added to index.json automatically
3. MATCH    → Next session: matched by tag overlap + confidence + recency
4. REUSE    → Agent applies pattern to similar task
5. SCORE    → Success: +0.05 / Failure: -0.10
6. PRUNE    → Below 0.1 confidence or 90 days unused + <2 uses → removed
```

## Confidence Scoring

| Event | Change | Range |
|-------|--------|-------|
| New pattern | Start at 0.5 | — |
| Successful reuse | +0.05 | Max 1.0 |
| Failed reuse | -0.10 | Min 0.0 |
| Below 0.1 | Prune candidate | — |
| Above 0.9 + 10 uses | Archive candidate (high value) | — |

Configurable in `memory/config/sona-config.json`.

## Retrieval Scoring

When matching patterns for a task, each pattern is scored:

| Factor | Weight | Description |
|--------|--------|-------------|
| Tag overlap | 0.4 | Fraction of query tags found in pattern tags |
| Confidence | 0.3 | Pattern's current confidence score |
| Recency | 0.2 | How recently the pattern was used |
| Usage frequency | 0.1 | How many times it's been reused |

Top-N results returned (default: 5). Configurable in `sona-config.json`.

## Hook Integration

| Hook | Event | What it does |
|------|-------|-------------|
| `08-sona-context-load.sh` | SessionStart | Loads stats, matches patterns from STATE.md topics |
| `02-sona-session-train.sh` | Stop | Reminds to extract/score patterns |

## Skill Integration

| Skill | SONA Step Added |
|-------|----------------|
| `session-start` | Step 5: Load SONA context, review matched patterns |
| `session-close` | Step 5: Score reused patterns, extract new ones, prune |
| `neural-pattern-extract` | Creates patterns following SCHEMA.md format |
| `neural-pattern-match` | Matches using sona_match_patterns |
| `neural-pattern-score` | Scores using sona_score_pattern |
| `neural-session-train` | Full session training workflow |
| `neural-context-build` | Assembles context block for agent prompts |

## Pattern Categories

| Category | Use for |
|----------|---------|
| `approach` | A technique that solved a problem |
| `error` | An error pattern to avoid (gotchas) |
| `architecture` | Architectural decisions or patterns |
| `workflow` | Processes that work well |
| `debugging` | Debugging techniques that found root cause |
| `config` | Configuration patterns or setup techniques |

## For Agents: When to Create Patterns

Create a pattern when:
- You discover a non-obvious debugging technique
- A configuration gotcha cost significant time
- You find an approach that generalizes to other projects
- An error keeps recurring across sessions
- A workflow proves reliable over multiple uses

Do NOT create patterns for:
- One-time fixes unlikely to recur
- Patterns already captured in code comments or docs
- Trivial operations (git commands, basic CRUD)

## Future: MongoDB Backend (Phase 5)

When the MCP server exists, patterns migrate to MongoDB:
- Collection: `ai_patterns`
- Schema: Same as JSON but with MongoDB indexing
- Text search on tags + description
- JSON files become the fallback for repos without MCP
