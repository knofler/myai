#!/usr/bin/env bash
# check_tenant_scoping.sh — ADR-010 §3.4 tenant-scoping regression gate
# (GRAND_PRODUCT §7.3 DoD: "tenant data isolated (verified by test)").
#
# Flags any raw query on a tenant-scoped collection model that lacks a tenant
# filter — the "forgotten filter" cross-tenant data-leak class. Row-level
# isolation (one DB, tenantId discriminator) means a missing `tenantId` in a
# .find/.findOne/.findOneAndUpdate/.updateOne/.deleteOne/.deleteMany/.aggregate/
# .countDocuments call on a scoped model IS an isolation breach. The
# compile-time defenses (mandatory tenantId store params + scoped-query.ts
# helpers) are primary; this is the regression backstop, run both by
# local-ci.sh (billing-outage fallback) and .github/workflows/tenant-isolation.yml
# (the normal ship-blocking path).
#
# Heuristic (grep gate, not a full static analyzer): for each hit, scan the
# enclosing window (25 lines back, 8 forward) for evidence of tenant scoping
# (tenantScope/withTenant/scoped*/getTenantScope/tenantId/SYSTEM_CONTEXT/
# DEFAULT_TENANT_ID) or an explicit `tenant-ok:` exemption marker. A deliberate
# cross-tenant system sweep (e.g. the scheduler's due-schedule poll) must carry
# a `tenant-ok:` comment justifying it.
#
# Model list = every collection with a `tenantId` field that is exclusively
# queried through scoped-query.ts today (verified 2026-07-22: `grep -rn
# 'scopedFind(\|scopedAggregate(\|…' runtime/src`). Auth-flow collections
# (User/Invite/PasswordReset/AccountUnlock/MagicLink/TenantApiKey/GiftCode/
# GiftRedemption/TenantRequestQuota/PushSubscription/NotificationPrefs/
# ErasureRequest) are deliberately NOT in this list — they are legitimately
# looked up by token/prefix/email BEFORE a tenant is known (that lookup IS the
# auth step); adding them here would false-positive on every login/reset flow.
#
# Usage: ./scripts/check_tenant_scoping.sh [--repo <path>]
# Exit codes: 0 pass, 1 violation found (BLOCKS the merge), 2 skip (no
# runtime/src, or python3 unavailable).

set -euo pipefail

REPO_ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_ROOT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

echo "[Tenant Scoping] ADR-010 §3.4 — scoped-model queries must carry tenantId"
SRC="$REPO_ROOT/runtime/src"
if [ ! -d "$SRC" ]; then
  echo "  SKIP — no runtime/src (not the gateway repo)"; exit 2
fi
command -v python3 >/dev/null 2>&1 || { echo "  SKIP — python3 unavailable for scan"; exit 2; }

report="$(SRC_DIR="$SRC" python3 - <<'PY'
import os, re
src = os.environ["SRC_DIR"]
# Every collection wired exclusively through scoped-query.ts (ADR-010 §1.1 +
# the day-2/day-3/day-10 stores + the extended repos/* stores).
MODELS = r"(TaskModel|ScheduleModel|PlanDayModel|RepoCardModel|VectorModel|GatewaySessionModel|BudgetUsageModel|NotificationModel|FleetRunModel|ArtifactModel|ConnectorModel|HandoffModel|WebhookEndpointModel|WebhookDeliveryModel|RunnerLeaseModel|ActivationEventModel)"
VERBS  = r"(find|findOne|findOneAndUpdate|updateOne|deleteOne|deleteMany|aggregate|countDocuments)"
HIT    = re.compile(MODELS + r"\." + VERBS + r"\b")
EXEMPT = re.compile(
    r"tenant-ok|tenantScope|withTenant|scopedFind|scopedFindOne|scopedUpdateOne|"
    r"scopedDeleteOne|scopedDeleteMany|scopedAggregate|scopedCountDocuments|"
    r"scopedFindOneAndUpdate|getTenantScope|SYSTEM_CONTEXT|DEFAULT_TENANT_ID|"
    # tenantId used as an actual filter/property token — shorthand or accessed
    # (`{ tenantId, x }`, `(tenantId)`, `ctx.tenantId`) — NOT a bare substring
    # match, which used to false-exempt any window merely *declaring* a
    # `tenantId: string` field (e.g. an interface) with no real query scoping.
    r"\btenantId\b\s*[,)}]|\.tenantId\b"
)
BACK, FWD = 25, 8
violations = []
for root, _dirs, files in os.walk(src):
    for fn in files:
        if not fn.endswith(".ts"):
            continue
        if fn.endswith((".test.ts", ".spec.ts")) or os.sep + "tests" + os.sep in root + os.sep:
            continue
        # The helper + model definitions legitimately reference the models raw.
        if fn in ("scoped-query.ts", "db.ts"):
            continue
        path = os.path.join(root, fn)
        try:
            lines = open(path, encoding="utf-8").read().splitlines()
        except Exception:
            continue
        for i, line in enumerate(lines):
            if not HIT.search(line):
                continue
            lo, hi = max(0, i - BACK), min(len(lines), i + FWD + 1)
            window = "\n".join(lines[lo:hi])
            if EXEMPT.search(window):
                continue
            rel = os.path.relpath(path, src)
            violations.append(f"runtime/src/{rel}:{i+1}: {line.strip()}")
if violations:
    print("VIOLATIONS")
    for v in violations:
        print(v)
PY
)"

if printf '%s' "$report" | grep -q '^VIOLATIONS$'; then
  echo "  FAIL — unscoped query on a tenant-scoped collection (cross-tenant leak risk):"
  printf '%s\n' "$report" | grep -v '^VIOLATIONS$' | sed 's/^/    ✗ /'
  echo "  FIX — route through scoped-query.ts (scopedFind/scopedUpdateOne/…) or add"
  echo "        { ...tenantScope(tenantId) } to the filter. A deliberate cross-tenant"
  echo "        system query must carry a '// tenant-ok: <reason>' marker."
  exit 1
fi
echo "  PASS — all scoped-model queries carry a tenant filter or sanctioned exemption"
exit 0
