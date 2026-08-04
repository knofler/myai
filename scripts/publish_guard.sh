#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# publish_guard.sh — CLEAN-ROOM PUBLISH LEAK SCANNER (P0 release gate)
#
# The published npm package (ai-management) must contain the FRAMEWORK
# ONLY — none of the operator's context. This is the defence-in-depth SECOND
# layer behind the package.json `files` allowlist (layer 1, opt-in):
#
#   1. `npm pack`  → build the real tarball that would be published.
#   2. extract it  → inspect EXACTLY what ships, not what we hope ships.
#   3. FAIL (exit 1) if the tarball contains ANY:
#        • file under  state/ plan/ memory/ logs/ LL/ architecture/ design/
#        • SHOWCASE.md, CLAUDE.md, .env, config/tenant_keys.env,
#          config/managed_repos.txt, config/schedule_*.txt (non-.example),
#          config/leak_patterns.txt, .git/, node_modules/
#        • operator home path (/Users/<you>, ~/Dropbox), operator email,
#          known operator repo names, or secret-shaped strings.
#
# Allowlist (opt-in, layer 1) + this scanner (verify, layer 2) ⇒ nothing leaks
# by default. A denylist alone (.npmignore) risks silent leaks; we use both.
#
# WIRED INTO:
#   • Day 5  (packaging hardening)  — run manually / smoke gate
#   • Day 9  (security pass)        — scripts/e2e_acceptance.sh probes it
#   • Day 10 (release)              — package.json `prepublishOnly` HARD BLOCKS
#                                     `npm publish` if this exits non-zero.
#
# USAGE
#   scripts/publish_guard.sh            # pack → extract → scan; exit 1 on leak
#   scripts/publish_guard.sh --keep     # leave the extracted tarball for inspection
#   scripts/publish_guard.sh --quiet    # only print the verdict + findings
#
# Exit codes: 0 = clean (safe to publish) · 1 = LEAK DETECTED (publish blocked)
#             2 = scanner error (npm/pack failure)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

KEEP=0; QUIET=0
for arg in "$@"; do
  case "$arg" in
    --keep)  KEEP=1 ;;
    --quiet) QUIET=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say()  { [ "$QUIET" = "1" ] || echo "$@"; }
hr()   { say "────────────────────────────────────────────────────────────────"; }

if [ ! -f package.json ]; then
  echo "publish_guard: no package.json at repo root — nothing to pack." >&2
  exit 2
fi

WORK="$(mktemp -d -t publish-guard.XXXXXX)"
cleanup() { [ "$KEEP" = "1" ] || rm -rf "$WORK"; }
trap cleanup EXIT

say ""
say "CLEAN-ROOM PUBLISH GUARD — packing & scanning the real tarball"
hr

# ── 0. Capability-counts drift gate — docs must match shipped truth ──────────
# README/SHOWCASE/package.json hardcode "NN agents / NN skills / NN MCP tools"
# in ~30 places; v0.6.2 reconciled them by hand and still shipped a wrong
# agent count. A release must not ship stale numbers.
if [ -x "$ROOT/scripts/check_capability_counts.sh" ]; then
  say "capability counts: checking README/SHOWCASE/package.json against shipped truth…"
  if COUNTS_OUT="$("$ROOT/scripts/check_capability_counts.sh" 2>&1)"; then
    say "capability counts: in sync."
  else
    echo ""
    echo "❌ PUBLISH BLOCKED — capability counts drifted from shipped truth:"
    echo ""
    echo "$COUNTS_OUT" | grep -E 'FAIL|ERROR|shipped truth|RESULT'
    echo ""
    echo "Fix: scripts/check_capability_counts.sh --fix  (rewrites the stale numbers),"
    echo "then review the diff and commit before publishing."
    exit 1
  fi
  hr
fi

# ── 1. Build the tarball npm would actually publish ──────────────────────────
# When invoked via prepublishOnly under `npm publish --dry-run`, npm exports
# npm_config_dry_run=true into this script's env — which would turn the nested
# `npm pack` into a dry-run that produces no tarball. Strip it: the guard must
# always pack a real tarball to scan, regardless of the outer command's mode.
TARBALL=""
if ! TARBALL="$(env -u npm_config_dry_run npm pack --pack-destination "$WORK" 2>"$WORK/pack.err" | tail -1)"; then
  echo "publish_guard: 'npm pack' failed:" >&2
  cat "$WORK/pack.err" >&2
  exit 2
fi
TARPATH="$WORK/$TARBALL"
[ -f "$TARPATH" ] || { echo "publish_guard: tarball not produced ($TARPATH)" >&2; exit 2; }
say "packed: $TARBALL"

# ── 2. Extract & list every shipped path ─────────────────────────────────────
PKG="$WORK/extract"
mkdir -p "$PKG"
tar -xzf "$TARPATH" -C "$PKG"
ROOTDIR="$PKG/package"   # npm tarballs root everything under package/
[ -d "$ROOTDIR" ] || ROOTDIR="$PKG"

FILES_LIST="$WORK/files.txt"
( cd "$ROOTDIR" && find . -type f | sed 's#^\./##' | sort ) > "$FILES_LIST"
FILE_COUNT="$(wc -l < "$FILES_LIST" | tr -d ' ')"
say "tarball contains $FILE_COUNT files"
hr

FINDINGS="$WORK/findings.txt"; : > "$FINDINGS"
note() { echo "  ✗ $*" >> "$FINDINGS"; }

# ── 3a. STRUCTURAL check — forbidden paths must not exist in the tarball ──────
# (these SHOULD already be excluded by the allowlist; this catches regressions)
FORBIDDEN_PATHS='^(state|plan|memory|logs|LL|architecture|design)/|(^|/)SHOWCASE\.md$|(^|/)CLAUDE\.md$|(^|/)\.env$|(^|/)\.env\.(local|development|production|test)|^config/managed_repos\.txt$|^config/schedule_(priority|ignore|focus)\.txt$|^config/tenant_keys\.env$|^config/leak_patterns\.txt$|(^|/)\.git/|(^|/)node_modules/|(^|/)\.next/|(^|/)(dist|build|out)/|\.tsbuildinfo$'
if grep -E "$FORBIDDEN_PATHS" "$FILES_LIST" >/dev/null 2>&1; then
  while IFS= read -r f; do
    note "FORBIDDEN PATH shipped: $f"
  done < <(grep -E "$FORBIDDEN_PATHS" "$FILES_LIST")
fi

# ── 3b. Build the operator-identity denylist, classified into two passes ─────
#   LITERAL  (substring match -F)  — paths & emails (contain @ / or ~)
#   NAME     (whole-word  match -wF) — repo codenames (generic words can't false+)
LITERAL="$WORK/literal.txt"; : > "$LITERAL"
NAME="$WORK/name.txt"; : > "$NAME"

classify() { # read tokens on stdin → append to LITERAL or NAME by shape
  while IFS= read -r tok; do
    [ -z "$tok" ] && continue
    case "$tok" in
      *@*|*/*|*~*) printf '%s\n' "$tok" >> "$LITERAL" ;;
      *)           printf '%s\n' "$tok" >> "$NAME" ;;
    esac
  done
}
# Seed list of known-sensitive operator tokens (NOT shipped — lives in config/).
if [ -f config/leak_patterns.txt ]; then
  grep -vE '^\s*#|^\s*$' config/leak_patterns.txt | classify
fi
# Live operator identity derived at scan time (adapts per-operator / per-forker):
{
  printf '%s\n' "$HOME"
  printf '/Users/%s\n' "$(whoami 2>/dev/null || echo __nouser__)"
  printf '/home/%s\n'  "$(whoami 2>/dev/null || echo __nouser__)"
  GIT_EMAIL="$(git config user.email 2>/dev/null || true)"
  [ -n "$GIT_EMAIL" ] && printf '%s\n' "$GIT_EMAIL"
} | classify
# De-dup; names must be >=4 chars (avoid stray short tokens matching as words).
sort -u "$LITERAL" | awk 'length($0) >= 4' > "$LITERAL.c" && mv "$LITERAL.c" "$LITERAL"
sort -u "$NAME"    | awk 'length($0) >= 4' > "$NAME.c"    && mv "$NAME.c" "$NAME"

# ── 3c. Regex denylist (secret-shaped + home-path shapes) ────────────────────
REGEX="$WORK/regex.txt"
cat > "$REGEX" <<'PATTERNS'
~/Dropbox
/Users/[A-Za-z0-9._-]+/Dropbox
/home/[A-Za-z0-9._-]+/Dropbox
sk-ant-[A-Za-z0-9_-]{16,}
AKIA[0-9A-Z]{16}
ghp_[A-Za-z0-9]{30,}
github_pat_[A-Za-z0-9_]{30,}
xox[baprs]-[A-Za-z0-9-]{10,}
AIza[0-9A-Za-z_-]{30,}
mongodb(\+srv)?://[^[:space:]/]*:[^[:space:]@/]+@
-----BEGIN[A-Z ]*PRIVATE KEY-----
PATTERNS

# Files we must NOT scan: the scanner's own source, the denylist seed, and any
# .example stub (intentionally generic) — these legitimately contain patterns.
EXCLUDES=( --exclude='*.example' --exclude='publish_guard.sh' --exclude='leak_patterns.txt' )

# ── 4. CONTENT scan over the extracted tarball ───────────────────────────────
emit() { # label < grep-output (file:lno:match)
  local label="$1"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local file="${line%%:*}"; local rest="${line#*:}"; local lno="${rest%%:*}"
    note "$label → ${file#./}:$lno"
  done
}
# Operator paths / emails (substring):
if [ -s "$LITERAL" ]; then
  grep -rIinF "${EXCLUDES[@]}" -f "$LITERAL" "$ROOTDIR" 2>/dev/null \
    | sed "s#${ROOTDIR}/##" | sort -u | head -200 | emit "operator path/email leaked"
fi
# Operator repo codenames (whole-word):
if [ -s "$NAME" ]; then
  grep -rIinwF "${EXCLUDES[@]}" -f "$NAME" "$ROOTDIR" 2>/dev/null \
    | sed "s#${ROOTDIR}/##" | sort -u | head -200 | emit "operator repo name leaked"
fi
# Secret-shaped + home/Dropbox shapes (regex):
# A mongodb URI pointed at a loopback / compose host with the framework's PUBLIC
# default cred (admin:password) is NOT an operator secret — it is the published
# self-hosted-stack default (config.ts ↔ docker-compose.yml must match). Drop
# those loopback-default matches so the gate doesn't false-positive on shipped
# defaults; a real Atlas/remote URI with creds (non-loopback host) still fails.
LOOPBACK_MONGO='mongodb(\+srv)?://[^[:space:]]*@(localhost|127\.0\.0\.1|0\.0\.0\.0|mongo)([:/]|$)'
# A mongodb URI whose credentials/host are documentation PLACEHOLDERS — shell
# vars (${USER}:${PASS}), angle-bracket tokens (<user>:<pass>), the literal
# dummy `user:pass`/`:password@`, or an `xxxx`-masked cluster — is a template,
# not an operator secret. Drop those so connection-string examples in docs and
# make-prod/setup-atlas scripts don't false-positive. A concrete URI with real
# creds (no ${ / < / dummy markers) still fails.
PLACEHOLDER_MONGO='mongodb(\+srv)?://[^[:space:]]*(\$\{|<[A-Za-z]|x{4,}\.mongodb|user:pass|:password@)'
grep -rIinE "${EXCLUDES[@]}" -f "$REGEX" "$ROOTDIR" 2>/dev/null \
  | sed "s#${ROOTDIR}/##" | grep -vE "$LOOPBACK_MONGO" | grep -vE "$PLACEHOLDER_MONGO" | sort -u | head -200 \
  | emit "secret/home pattern"

# ── 5. Verdict ───────────────────────────────────────────────────────────────
hr
if [ -s "$FINDINGS" ]; then
  COUNT="$(wc -l < "$FINDINGS" | tr -d ' ')"
  echo ""
  echo "❌ PUBLISH BLOCKED — $COUNT clean-room leak(s) found in the tarball:"
  echo ""
  cat "$FINDINGS"
  echo ""
  echo "Fix: remove the offending path from package.json \`files\`, genericise the"
  echo "file (no operator paths/emails/repo names), or move it out of a shipped dir."
  [ "$KEEP" = "1" ] && echo "Extracted tarball kept at: $ROOTDIR"
  exit 1
fi

say ""
say "✅ CLEAN-ROOM PASS — tarball ships the framework only ($FILE_COUNT files, 0 leaks)."
say "   Safe to publish."
exit 0
