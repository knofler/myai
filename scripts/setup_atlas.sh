#!/usr/bin/env bash
set -uo pipefail
# ════════════════════════════════════════════════════════════════════════════
#  setup_atlas.sh — provision MongoDB Atlas + cut the gateway/dashboard/Vercel
#  over to it (ADR-011 slice 5). One command, after `atlas auth login`.
#
#  Does: ensure project + M0 cluster → DB user → network allow-list → build the
#  connection string → write AI/.env → restart gateway+dashboard on Atlas →
#  migrate the local mongo data → set the Vercel project env → verify.
#
#  Idempotent: reuses an existing cluster/user/allow-list if present.
#  Prereq: `atlas auth login` (CLI session valid) + `vercel` logged in.
# ════════════════════════════════════════════════════════════════════════════
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_NAME="${ATLAS_PROJECT:-myAI}"
CLUSTER="${ATLAS_CLUSTER:-myai}"
TIER="${ATLAS_TIER:-M0}"
# M0 free tier supported AWS regions (try Sydney → Singapore → N.Virginia)
REGIONS="${ATLAS_REGIONS:-AP_SOUTHEAST_2 AP_SOUTHEAST_1 US_EAST_1}"
DBUSER="${ATLAS_DBUSER:-myai_app}"
DBNAME="${MONGODB_NAME:-myai}"
ENV_FILE="$ROOT/.env"

log() { echo "[setup-atlas] $*"; }
die() { echo "[setup-atlas] ERROR: $*" >&2; exit 1; }

command -v atlas >/dev/null || die "atlas CLI not installed"
command -v vercel >/dev/null || log "vercel CLI missing — will skip the Vercel env step"
atlas projects list >/dev/null 2>&1 || die "atlas session expired — run:  atlas auth login   then re-run this script"

# ── 1. Project ───────────────────────────────────────────────────────────────
PROJECT_ID=$(atlas projects list -o json 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin); res=d.get('results',d) if isinstance(d,dict) else d
print(next((p['id'] for p in res if p.get('name')=='$PROJECT_NAME'), ''))" 2>/dev/null)
if [ -z "$PROJECT_ID" ]; then
  log "creating project $PROJECT_NAME"
  PROJECT_ID=$(atlas projects create "$PROJECT_NAME" -o json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
fi
[ -n "$PROJECT_ID" ] || die "could not resolve/create project"
log "project: $PROJECT_NAME ($PROJECT_ID)"

# ── 2. Cluster (M0) — reuse if present, else create in first region that takes M0 ─
HAVE=$(atlas clusters list --projectId "$PROJECT_ID" -o json 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin); res=d.get('results',d) if isinstance(d,dict) else d
print('yes' if any(c.get('name')=='$CLUSTER' for c in res) else '')" 2>/dev/null)
if [ -z "$HAVE" ]; then
  created=""
  for R in $REGIONS; do
    log "creating $TIER cluster '$CLUSTER' in $R …"
    if atlas clusters create "$CLUSTER" --projectId "$PROJECT_ID" --provider AWS --region "$R" --tier "$TIER" --tag env=myai 2>&1 | tee /tmp/atlas-create.log; then
      created="yes"; break
    fi
    log "  region $R rejected (M0 may be unavailable there) — trying next"
  done
  [ -n "$created" ] || die "could not create M0 cluster in any region ($REGIONS) — see /tmp/atlas-create.log"
else
  log "cluster '$CLUSTER' already exists — reusing"
fi
log "waiting for cluster to be ready (idle) …"
atlas clusters watch "$CLUSTER" --projectId "$PROJECT_ID" 2>/dev/null || true

# ── 3. DB user ───────────────────────────────────────────────────────────────
DBPASS=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
if atlas dbusers describe "$DBUSER" --projectId "$PROJECT_ID" >/dev/null 2>&1; then
  log "db user $DBUSER exists — rotating password"
  atlas dbusers update "$DBUSER" --projectId "$PROJECT_ID" --password "$DBPASS" >/dev/null 2>&1 \
    || { log "update failed — recreating"; atlas dbusers delete "$DBUSER" --projectId "$PROJECT_ID" --force >/dev/null 2>&1; atlas dbusers create --username "$DBUSER" --password "$DBPASS" --role atlasAdmin --projectId "$PROJECT_ID" >/dev/null 2>&1; }
else
  log "creating db user $DBUSER"
  atlas dbusers create --username "$DBUSER" --password "$DBPASS" --role atlasAdmin --projectId "$PROJECT_ID" >/dev/null 2>&1 || die "db user create failed"
fi

# ── 4. Network access (dev: 0.0.0.0/0 — Vercel egress is dynamic + two Macs) ──
atlas accessLists create "0.0.0.0/0" --type ipAddress --comment "myai dev (Vercel+Macs)" --projectId "$PROJECT_ID" >/dev/null 2>&1 \
  && log "network allow-list: 0.0.0.0/0 added" || log "network allow-list: already present"

# ── 5. Connection string ─────────────────────────────────────────────────────
SRV=$(atlas clusters connectionStrings describe "$CLUSTER" --projectId "$PROJECT_ID" -o json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('standardSrv',''))")
[ -n "$SRV" ] || die "could not read connection string"
HOST="${SRV#mongodb+srv://}"
ATLAS_URI="mongodb+srv://${DBUSER}:${DBPASS}@${HOST}/${DBNAME}?retryWrites=true&w=majority"
log "connection string built (host: ${HOST})"

# ── 6. Write AI/.env (gateway+dashboard read MONGODB_URI; compose substitutes it) ─
touch "$ENV_FILE"
grep -vE '^(MONGODB_URI|MONGODB_NAME)=' "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
{ cat "$ENV_FILE.tmp"; echo "MONGODB_URI=$ATLAS_URI"; echo "MONGODB_NAME=$DBNAME"; } > "$ENV_FILE"
rm -f "$ENV_FILE.tmp"
chmod 600 "$ENV_FILE"
log "wrote MONGODB_URI to $ENV_FILE (chmod 600)"

# ── 7. Migrate local mongo → Atlas (dump from local container, restore to Atlas) ─
if [ "${SKIP_MIGRATE:-0}" = "1" ]; then
  log "SKIP_MIGRATE=1 — leaving Atlas data untouched (provision + wire only)"
elif docker ps --format '{{.Names}}' | grep -q '^myai-mongo$'; then
  log "migrating local data → Atlas …"
  docker exec myai-mongo sh -c "mongodump --uri='mongodb://admin:password@localhost:27017/${DBNAME}?authSource=admin' --archive" 2>/dev/null \
    | docker exec -i myai-mongo sh -c "mongorestore --uri='$ATLAS_URI' --archive --drop" 2>/dev/null \
    && log "data migrated" || log "migration warning — check manually (collections may be empty on first run)"
else
  log "local mongo container not running — skipping data migration"
fi

# ── 8. Restart gateway + dashboard on Atlas ──────────────────────────────────
log "restarting gateway + dashboard on Atlas …"
( cd "$ROOT" && docker compose up -d gateway dashboard ) >/dev/null 2>&1 || log "compose restart warning"

# ── 9. Vercel env (production + preview) ─────────────────────────────────────
if command -v vercel >/dev/null && [ -d "$ROOT/.vercel" ]; then
  for tgt in production preview; do
    printf '%s' "$ATLAS_URI" | ( cd "$ROOT" && vercel env rm MONGODB_URI "$tgt" -y >/dev/null 2>&1; vercel env add MONGODB_URI "$tgt" >/dev/null 2>&1 ) \
      && log "vercel env MONGODB_URI set ($tgt)" || log "vercel env $tgt — set manually if needed"
  done
else
  log "vercel not linked here — set MONGODB_URI in the Vercel project manually (value in $ENV_FILE)"
fi

# ── 10. Verify ───────────────────────────────────────────────────────────────
sleep 8
log "verify — gateway tools + task count against Atlas:"
curl -sf -X POST http://localhost:3100/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"tasks_list","arguments":{"limit":5}},"id":1}' 2>/dev/null \
  | python3 -c "import sys,json;c=json.load(sys.stdin).get('result',{}).get('content',[]);t=json.loads(c[0]['text']) if c else [];t=t if isinstance(t,list) else t.get('tasks',[]);print('  Atlas-backed gateway returned',len(t),'tasks')" 2>/dev/null || log "  gateway verify failed — check 'docker logs myai-gateway'"
log "DONE. localhost + Vercel now read the same Atlas DB. Keep AI/.env private (it has the URI)."
