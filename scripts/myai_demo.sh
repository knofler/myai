#!/usr/bin/env bash
# =============================================================================
# myai_demo.sh — seed the gateway with a realistic DEMO data set so a
# first-run dashboard is alive (not a wall of empty panels).
#
# Seeds (all rows tagged/namespaced `demo` so they are cleanly removable):
#   - 6 tasks across all statuses (pending/working/review/done/blocked),
#     sourceId "demo", repos demo-*
#   - 2 schedules (created DISABLED — they never dispatch real agent runs),
#     names prefixed "[demo] "
#   - 1 ten-column plan (5 days) for demo-storefront → dashboard /plan
#   - 3 repo cards (ok / warn / error status mix) → dashboard /directory
#   - 3 memory vectors (local embeddings — zero API cost), tags ["demo", ...]
#   - 8 budget-usage rows spread over the past week → dashboard /budget
#     (direct Mongo insert — the gateway has no usage-write API by design)
#
# Usage:
#   scripts/myai_demo.sh            # seed (idempotent: no-op if already seeded)
#   scripts/myai_demo.sh --force    # clean then re-seed
#   scripts/myai_demo.sh --clean    # remove every demo row
#
# Requires: bash + node >= 20 (fetch built in). No curl/python/jq — this must
# also run inside the node:20-slim CI container. The direct-Mongo steps (budget
# rows on seed; task/plan/card/vector removal on clean) run `node` INSIDE the
# gateway container so they always hit the SAME database the gateway uses —
# local compose mongo or Atlas (post ADR-011 cutover) alike. They are skipped
# with a warning when docker/the container is unavailable or DEMO_SKIP_MONGO=1
# (all other seeding is pure gateway API).
#
# Env: GATEWAY_MCP (default http://localhost:3100/mcp), GATEWAY_LOCAL_TOKEN
#      (via scripts/lib/gateway.sh), MYAI_GATEWAY_CONTAINER (default
#      myai-gateway), DEMO_SKIP_MONGO=1 to skip the direct-Mongo steps.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATEWAY_MCP=${GATEWAY_MCP:-http://localhost:3100/mcp}
# Local-token escape hatch — gateway enforces auth (ADR-010 M1); host calls aren't loopback.
. "$SCRIPT_DIR/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
export GATEWAY_MCP GATEWAY_LOCAL_TOKEN

GATEWAY_CONTAINER=${MYAI_GATEWAY_CONTAINER:-myai-gateway}

ACTION="seed"; FORCE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --clean) ACTION="clean" ;;
    --force) FORCE=true ;;
    --skip-mongo) DEMO_SKIP_MONGO=1 ;;
    -h|--help) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

# ── gateway helpers (node-based: no curl/python in node:20-slim) ─────────────

# mcp <tool> <args-json> → prints the tool's inner JSON text; exits 1 on error.
mcp() {
  node -e '
    const [tool, argsJson] = process.argv.slice(1);
    fetch(process.env.GATEWAY_MCP, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gateway-local-token": process.env.GATEWAY_LOCAL_TOKEN || "",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 1,
        params: { name: tool, arguments: JSON.parse(argsJson) } }),
    }).then(async (r) => {
      if (!r.ok) { console.error(`gateway HTTP ${r.status} on ${tool}`); process.exit(1); }
      const d = await r.json();
      if (d.error) { console.error(d.error.message || JSON.stringify(d.error)); process.exit(1); }
      const text = d.result?.content?.[0]?.text ?? "";
      try { const inner = JSON.parse(text);
        if (inner && inner.error) { console.error(`${tool}: ${inner.error}`); process.exit(1); }
      } catch { /* non-JSON text is fine */ }
      process.stdout.write(text);
    }).catch((e) => { console.error(`${tool}: ${e.message}`); process.exit(1); });
  ' "$1" "$2"
}

# jget <json> <js-expr over d> → prints the value ("" for null/undefined).
jget() {
  node -e '
    let d; try { d = JSON.parse(process.argv[1]); } catch { process.exit(0); }
    const v = Function("d", `return (${process.argv[2]})`)(d);
    if (v !== undefined && v !== null) process.stdout.write(String(v));
  ' "$1" "$2"
}

gateway_up() {
  node -e '
    fetch(process.env.HEALTH_URL).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
  ' 2>/dev/null
}

HEALTH_URL="${GATEWAY_MCP%/mcp}/health"
export HEALTH_URL
if ! gateway_up; then
  echo "✗ Gateway not reachable at $GATEWAY_MCP" >&2
  echo "  Start it first: myai up  (or docker compose up -d)  → then retry." >&2
  exit 1
fi

# ── direct-Mongo helper ───────────────────────────────────────────────────────
# Runs node INSIDE the gateway container (its MONGODB_URI + bundled mongodb
# driver), so this hits the exact database the dashboard reads — the local
# compose mongo AND an Atlas cutover both Just Work. mongosh against the mongo
# container would silently target the wrong DB post-cutover.
mongo_ok() {
  [ "${DEMO_SKIP_MONGO:-0}" = "1" ] && return 1
  command -v docker >/dev/null 2>&1 || return 1
  docker exec "$GATEWAY_CONTAINER" node -e 'require("mongodb")' >/dev/null 2>&1
}

mongo_eval() { # $1 = js body run with (db) connected; print() is wired to console.log
  docker exec -i "$GATEWAY_CONTAINER" node -e "
    const { MongoClient } = require('mongodb');
    const print = console.log;
    (async () => {
      const client = new MongoClient(process.env.MONGODB_URI);
      await client.connect();
      const db = client.db(process.env.MONGODB_NAME || 'myai');
      const tenantId = process.env.DEFAULT_TENANT_ID || 'default';
      try { $1 } finally { await client.close(); }
    })().catch((e) => { console.error(e.message); process.exit(1); });
  "
}

# ── clean ─────────────────────────────────────────────────────────────────────
clean_demo() {
  echo "== myai demo --clean =="

  # 1. Schedules — via the gateway (it owns the cron registry).
  local sched_json ids deleted=0
  sched_json="$(mcp schedules_list '{"limit":200}')"
  ids="$(jget "$sched_json" '(Array.isArray(d) ? d : (d.schedules || [])).filter(s => String(s.name || "").startsWith("[demo]")).map(s => s.scheduleId).join(" ")')"
  for id in $ids; do
    mcp schedules_delete "{\"scheduleId\":\"$id\"}" >/dev/null
    deleted=$((deleted + 1))
  done
  echo "  ✓ schedules: removed $deleted"

  # 2. Everything else — direct Mongo (tasks/plans/cards/vectors/budget have
  #    no delete API; demo rows are namespaced so the match is exact).
  if mongo_ok; then
    mongo_eval '
      const out = {
        tasks: (await db.collection("tasks").deleteMany({ sourceId: "demo" })).deletedCount,
        planDays: (await db.collection("plandays").deleteMany({ repo: /^demo-/ })).deletedCount,
        repoCards: (await db.collection("repocards").deleteMany({ repoName: /^demo-/ })).deletedCount,
        vectors: (await db.collection("vectors").deleteMany({ tags: "demo" })).deletedCount,
        budgetRows: (await db.collection("budgetusages").deleteMany({ callId: /^demo-usage-/ })).deletedCount,
      };
      print(`  ✓ tasks: removed ${out.tasks}`);
      print(`  ✓ plan days: removed ${out.planDays}`);
      print(`  ✓ repo cards: removed ${out.repoCards}`);
      print(`  ✓ memory vectors: removed ${out.vectors}`);
      print(`  ✓ budget rows: removed ${out.budgetRows}`);
    '
  else
    echo "  !! gateway container '$GATEWAY_CONTAINER' unavailable — tasks/plan/cards/vectors/budget rows NOT removed" >&2
    echo "     Re-run with the stack up (myai up), or clean manually in the gateway's database." >&2
  fi
  echo "Demo data clean complete."
}

# ── seed ──────────────────────────────────────────────────────────────────────
seed_demo() {
  echo "== myai demo — seeding sample data =="

  # Idempotency: demo tasks present → no-op unless --force.
  local existing count
  existing="$(mcp tasks_list '{"repo":"demo-storefront","limit":10}')"
  count="$(jget "$existing" '(Array.isArray(d) ? d : (d.tasks || [])).filter(t => t.sourceId === "demo").length')"
  if [ "${count:-0}" -gt 0 ]; then
    if $FORCE; then
      echo "  demo data already present — --force: cleaning first"
      clean_demo
      echo
    else
      echo "Demo data already seeded ($count demo task(s) found)."
      echo "  Re-seed:  myai demo --force"
      echo "  Remove:   myai demo --clean"
      return 0
    fi
  fi

  # 1. Tasks — 6 across all five statuses. sourceId "demo" is the removal key.
  #    Format: repo|title|priority|agent|status|prUrl|description
  local tasks=(
    'demo-storefront|Fix checkout 500 when cart has a discounted item|P0|api-specialist|pending||Stripe payment-intent creation throws when a negative line item is present. Repro: add SAVE10 coupon, checkout.'
    'demo-storefront|Add product search with typeahead|P1|frontend-specialist|working||Debounced search across the catalogue with keyboard navigation and recent-searches memory.'
    'demo-api-service|Rate-limit public API endpoints (100 req/min)|P1|security-specialist|review|https://github.com/example/demo-api-service/pull/42|Sliding-window limiter on /v1/orders and /v1/inventory with Retry-After headers.'
    'demo-api-service|Compound index on orders(customerId, createdAt)|P2|database-specialist|done||Order-history query dropped from 900ms to 120ms p95 after the index landed.'
    'demo-mobile-app|Push notifications broken - APNs cert expired|P1|dev-mobile|blocked||Waiting on the Apple developer account renewal before a new cert can be issued.'
    'demo-mobile-app|Dark mode polish on the settings screen|P3|ui-ux-specialist|pending||Contrast fixes for toggles and section headers; match the design tokens used on Home.'
  )
  local created=0 line repo title prio agent status prurl desc res task_id update
  for line in "${tasks[@]}"; do
    IFS='|' read -r repo title prio agent status prurl desc <<<"$line"
    res="$(mcp tasks_create "{\"repo\":\"$repo\",\"title\":\"$title\",\"priority\":\"$prio\",\"assignedAgent\":\"$agent\",\"source\":\"manual\",\"sourceId\":\"demo\",\"description\":\"$desc\",\"notes\":\"Sample task seeded by 'myai demo' - remove with 'myai demo --clean'.\"}")"
    task_id="$(jget "$res" 'd.taskId')"
    if [ -n "$task_id" ] && [ "$status" != "pending" ]; then
      update="{\"taskId\":\"$task_id\",\"status\":\"$status\""
      [ -n "$prurl" ] && update="$update,\"prUrl\":\"$prurl\""
      update="$update}"
      mcp tasks_update "$update" >/dev/null
    fi
    created=$((created + 1))
  done
  echo "  ✓ tasks: $created created (pending ×2, working, review, done, blocked)"

  # 2. Schedules — DISABLED so they never dispatch a real (billed) agent run.
  mcp schedules_create '{"name":"[demo] Morning fleet digest","cronExpr":"0 9 * * *","kind":"tool","target":"morning_sweep","message":"{}","enabled":false}' >/dev/null
  mcp schedules_create '{"name":"[demo] Nightly dependency audit","cronExpr":"30 2 * * *","kind":"agent","target":"analysis-dependency","repo":"demo-api-service","message":"Audit npm dependencies for CVEs and licence drift; open tasks for anything actionable.","enabled":false}' >/dev/null
  echo "  ✓ schedules: 2 created (disabled — display only, never dispatched)"

  # 3. Plan — 5-day roadmap for demo-storefront (dashboard /plan).
  mcp plan_set '{"repo":"demo-storefront","replace":true,"days":[
    {"day":1,"focus":"Scaffold storefront: Next.js 15 + product catalogue model","status":"done"},
    {"day":2,"focus":"Checkout flow: cart, payment intents, webhook handlers","status":"done"},
    {"day":3,"focus":"Product search with typeahead across the catalogue","status":"enabled"},
    {"day":4,"focus":"Order history + transactional email receipts","status":"enabled"},
    {"day":5,"focus":"Performance pass: LCP under 2s, bundle diet, image CDN","status":"enabled"}
  ]}' >/dev/null
  echo "  ✓ plan: demo-storefront 5-day roadmap (2 done, 3 upcoming)"

  # 4. Repo cards — one healthy, one warning, one erroring (dashboard /directory).
  mcp repos_card_upsert '{"repoName":"demo-storefront","group":"demo","description":"E-commerce storefront - Next.js 15 + Stripe demo shop","localhostUrl":"http://localhost:3000","appUrl":"https://demo-storefront.example.com","mongo":"local :27017/storefront","lastStatus":"v1.2 shipped - checkout conversion up 8% week-on-week","lastStatusLevel":"ok","reportedBy":"myai demo"}' >/dev/null
  mcp repos_card_upsert '{"repoName":"demo-api-service","group":"demo","description":"Public REST API - orders, inventory, webhooks","localhostUrl":"http://localhost:4000","apiUrl":"https://api.demo.example.com","mongo":"local :27017/orders","lastStatus":"Rate-limit PR in review; p95 latency 340ms and rising","lastStatusLevel":"warn","reportedBy":"myai demo"}' >/dev/null
  mcp repos_card_upsert '{"repoName":"demo-mobile-app","group":"demo","description":"React Native companion app (iOS + Android)","localhostUrl":"http://localhost:8081","lastStatus":"Push notifications down - APNs certificate expired","lastStatusLevel":"error","reportedBy":"myai demo"}' >/dev/null
  echo "  ✓ repo cards: 3 upserted (ok / warn / error)"

  # 5. Memory vectors — embedded locally (hash/local provider), zero API cost.
  mcp memory_store '{"repo":"demo-storefront","source":"pattern","tags":["demo","stripe","webhooks"],"content":"Checkout webhooks must be idempotent - Stripe retries delivery for up to 3 days, so payment_intent.succeeded handlers key off the event id and short-circuit on replays."}' >/dev/null
  mcp memory_store '{"repo":"demo-storefront","source":"state","tags":["demo","sprint"],"content":"Sprint focus: product search with typeahead. Checkout flow shipped in v1.2; next up is order history and email receipts. Blocked on nothing."}' >/dev/null
  mcp memory_store '{"repo":"demo-api-service","source":"commit","tags":["demo","perf","mongodb"],"content":"fix(api): compound index on orders(customerId, createdAt) - order-history endpoint p95 dropped from 900ms to 120ms under the same load profile."}' >/dev/null
  echo "  ✓ memory: 3 vectors stored (local embeddings)"

  # 6. Budget usage rows — direct Mongo (gateway records usage only on real LLM
  #    calls; a demo must not make any). callId prefix demo-usage- is the key.
  if mongo_ok; then
    mongo_eval '
      const coll = db.collection("budgetusages");
      await coll.deleteMany({ callId: /^demo-usage-/ });
      // [daysAgo, model, agent, inputTokens, outputTokens, costUsd]
      const rows = [
        [6,   "claude-fable-5",        "api-specialist",      48200, 5200, 0.92],
        [5,   "claude-sonnet-5",       "frontend-specialist", 31500, 4100, 0.31],
        [4,   "claude-fable-5",        "security-specialist", 55800, 6900, 1.08],
        [3,   "claude-haiku-4-5-20251001", "qa-specialist",   12400, 1800, 0.04],
        [2,   "claude-sonnet-5",       "database-specialist", 28700, 3600, 0.27],
        [1.5, "claude-fable-5",        "dev-mobile",          61200, 7400, 1.21],
        [0.5, "claude-haiku-4-5-20251001", "documentation-specialist", 9800, 2300, 0.04],
        [0.2, "claude-fable-5",        "api-specialist",      44100, 5900, 0.95],
      ];
      await coll.insertMany(rows.map(([days, model, agent, inp, out, cost], i) => {
        const at = new Date(Date.now() - days * 864e5);
        return {
          tenantId, callId: `demo-usage-${i + 1}`,
          channelId: "demo", channelType: "demo", agentName: agent,
          provider: "anthropic", model,
          inputTokens: inp, outputTokens: out, costUsd: cost,
          cacheReadInputTokens: Math.floor(inp * 0.6),
          batchMode: i % 3 === 0,
          metadata: { demo: true },
          createdAt: at, updatedAt: at,
        };
      }));
      const n = await coll.countDocuments({ callId: /^demo-usage-/ });
      print(`  ✓ budget: ${n} usage rows over the past week`);
    '
  else
    echo "  !! budget rows skipped — gateway container '$GATEWAY_CONTAINER' unavailable or DEMO_SKIP_MONGO=1"
  fi

  local dash="${DASH_URL:-http://localhost:3210}"
  echo
  echo "Demo data seeded. Take a look:"
  echo "  $dash            (overview)"
  echo "  $dash/schedule   (tasks + schedules)"
  echo "  $dash/plan       (demo-storefront roadmap)"
  echo "  $dash/directory  (repo cards)"
  echo "Remove any time with: myai demo --clean"
}

case "$ACTION" in
  clean) clean_demo ;;
  seed)  seed_demo ;;
esac
