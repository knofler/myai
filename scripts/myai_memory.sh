#!/usr/bin/env bash
# myai_memory.sh — portable memory bundle export/import (`myai memory …`).
#
#   myai memory export [dir] [--repo <name>] [--source <src>]
#       Pull the gateway's memory corpus (source texts behind the embeddings:
#       state, handoff, patterns, archive, …) into a portable bundle dir:
#         <dir>/manifest.json      JSON manifest (counts + entry index)
#         <dir>/memory/**/*.md     one markdown file per entry (frontmatter
#                                  = provenance, body = source text)
#         <dir>/extras/            verbatim copies of state/STATE.md,
#                                  state/AI_AGENT_HANDOFF.md and
#                                  memory/patterns/*.json when run from a repo
#       Embeddings are NOT exported — the bundle is embedding-model-agnostic.
#       Every written file is secret-scanned (same patterns as the commit
#       hook) and matches are redacted, so a bundle never carries a live
#       credential off-machine. Skip with MYAI_EXPORT_NO_REDACT=1.
#
#   myai memory import <dir>
#       Push a bundle dir into the local gateway. Each markdown entry is
#       RE-EMBEDDED on this gateway and deduplicated by content hash, so
#       importing twice (or importing overlap with existing corpus) is safe.
#
# This is the migration onramp: a bundle from another machine — or a folder of
# hand-written markdown notes with `repo:`/`source:` frontmatter — imports the
# same way. Kill-the-lock-in guarantee: your memory is always a folder of
# markdown you can walk away with.
#
# Env: GATEWAY_URL (default http://localhost:3100), GATEWAY_LOCAL_TOKEN (auto
# from .env via scripts/lib/gateway.sh).
set -euo pipefail

GATEWAY_URL=${GATEWAY_URL:-http://localhost:3100}
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/gateway.sh
. "$HERE/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
# Secret-scan patterns — same regexes the commit hook (03-secret-scan.sh) blocks
# on. Export redacts matches so a bundle you copy off-machine never carries a
# live credential. See SECURITY.md → "Memory export is secret-scanned".
# shellcheck source=lib/secret_patterns.sh
SECRET_LIB_OK=1
. "$HERE/lib/secret_patterns.sh" 2>/dev/null || SECRET_LIB_OK=0

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "myai memory: '$1' is required" >&2; exit 2; }; }
need curl; need jq

gateway_up() {
  curl -sf -o /dev/null "$GATEWAY_URL/health" 2>/dev/null || {
    echo "✗ Gateway not reachable at $GATEWAY_URL — run 'myai up' first." >&2
    exit 1
  }
}

cmd_export() {
  local dir="" repo="" source=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) shift; repo="${1:?--repo needs a value}";;
      --source) shift; source="${1:?--source needs a value}";;
      -h|--help) usage; exit 0;;
      -*) echo "myai memory export: unknown flag $1" >&2; exit 2;;
      *) dir="$1";;
    esac; shift
  done
  [ -n "$dir" ] || dir="myai-memory-bundle-$(date +%Y%m%d-%H%M%S)"
  gateway_up

  local qs=""
  [ -n "$repo" ] && qs="repo=$(jq -rn --arg v "$repo" '$v|@uri')"
  [ -n "$source" ] && qs="${qs}${qs:+&}source=$(jq -rn --arg v "$source" '$v|@uri')"

  local bundle
  bundle=$(curl -sf -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
    "$GATEWAY_URL/api/memory/export${qs:+?$qs}") || {
    echo "✗ Export request failed (check gateway logs)." >&2; exit 1;
  }

  mkdir -p "$dir"
  printf '%s\n' "$bundle" | jq '.manifest' > "$dir/manifest.json"

  # Write each markdown file exactly as the gateway rendered it (base64 hop
  # keeps multi-line content + special chars intact through the shell).
  local n=0 b64 fpath
  while IFS= read -r b64; do
    [ -n "$b64" ] || continue
    fpath="$(printf '%s' "$b64" | base64 -d | jq -r '.path')"
    case "$fpath" in
      *..*|/*) echo "  ! skipping suspicious path: $fpath" >&2; continue;;
    esac
    mkdir -p "$dir/$(dirname "$fpath")"
    printf '%s' "$b64" | base64 -d | jq -j '.content' > "$dir/$fpath"
    n=$((n + 1))
  done < <(printf '%s\n' "$bundle" | jq -r '.files[] | @base64')

  # Extras: verbatim state + pattern files from the current repo (portability
  # copies for the operator — import sends only the memory/*.md entries).
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
  local extras=0
  for f in "$root/state/STATE.md" "$root/state/AI_AGENT_HANDOFF.md" \
           "$root/AI/state/STATE.md" "$root/AI/state/AI_AGENT_HANDOFF.md"; do
    [ -f "$f" ] && { mkdir -p "$dir/extras/state"; cp "$f" "$dir/extras/state/"; extras=$((extras + 1)); }
  done
  for d in "$root/memory/patterns" "$root/AI/memory/patterns"; do
    if [ -d "$d" ] && ls "$d"/*.json >/dev/null 2>&1; then
      mkdir -p "$dir/extras/patterns"; cp "$d"/*.json "$dir/extras/patterns/"; extras=$((extras + 1))
    fi
  done

  # Secret scan + redact (MANDATORY, SECURITY.md): sweep every file written to
  # the bundle — entries, manifest, extras — with the same patterns the commit
  # hook enforces, replacing live-credential-shaped matches with [REDACTED-*].
  # A bundle is built to leave the machine; it must never carry a secret.
  # Escape hatch for a deliberate raw export: MYAI_EXPORT_NO_REDACT=1.
  local redacted=0 hits
  if [ "${MYAI_EXPORT_NO_REDACT:-0}" = "1" ]; then
    echo "  ! MYAI_EXPORT_NO_REDACT=1 — secret scan SKIPPED, bundle may contain live credentials" >&2
  elif [ "$SECRET_LIB_OK" != "1" ]; then
    echo "✗ lib/secret_patterns.sh not found — refusing to export unscanned bundle." >&2
    echo "  (set MYAI_EXPORT_NO_REDACT=1 to export anyway, at your own risk)" >&2
    exit 1
  else
    while IFS= read -r -d '' f; do
      if secret_scan_file "$f" >/dev/null; then
        hits=$(secret_redact_file "$f")
        redacted=$((redacted + ${hits:-0}))
        echo "  ! redacted ${hits:-?} secret(s) in ${f#"$dir"/}" >&2
      fi
    done < <(find "$dir" -type f \( -name '*.md' -o -name '*.json' \) -print0)
  fi

  local total; total=$(jq -r '.counts.total' "$dir/manifest.json")
  echo "✓ Exported $total memory entries ($n files) to $dir/"
  [ "$redacted" -gt 0 ] && echo "  ⚠ $redacted secret(s) redacted — review the flagged entries; rotate any credential that was live"
  jq -r '.counts.bySource | to_entries[] | "    \(.key): \(.value)"' "$dir/manifest.json"
  [ "$extras" -gt 0 ] && echo "  + extras/ (state + pattern file copies)"
  echo "  Import elsewhere with: myai memory import $dir"
}

cmd_import() {
  local dir=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) usage; exit 0;;
      -*) echo "myai memory import: unknown flag $1" >&2; exit 2;;
      *) dir="$1";;
    esac; shift
  done
  [ -n "$dir" ] || { echo "myai memory import: bundle dir required" >&2; usage >&2; exit 2; }
  [ -d "$dir" ] || { echo "myai memory import: no such dir: $dir" >&2; exit 2; }
  gateway_up

  local files=()
  while IFS= read -r -d '' f; do files+=("$f"); done \
    < <(find "$dir/memory" -type f -name '*.md' -print0 2>/dev/null)
  # Frontmatter'd markdown dropped at the bundle root (hand-authored notes)
  # counts too — the migration-onramp case.
  while IFS= read -r -d '' f; do files+=("$f"); done \
    < <(find "$dir" -maxdepth 1 -type f -name '*.md' -print0 2>/dev/null)
  [ "${#files[@]}" -gt 0 ] || { echo "myai memory import: no .md entries under $dir" >&2; exit 2; }

  # Assemble { manifest?, files: [{path, content}] } and POST.
  local payload
  if [ -f "$dir/manifest.json" ]; then
    payload=$(for f in "${files[@]}"; do
      jq -Rs --arg p "${f#"$dir"/}" '{path: $p, content: .}' "$f"
    done | jq -s --slurpfile manifest "$dir/manifest.json" '{manifest: $manifest[0], files: .}')
  else
    payload=$(for f in "${files[@]}"; do
      jq -Rs --arg p "${f#"$dir"/}" '{path: $p, content: .}' "$f"
    done | jq -s '{files: .}')
  fi

  local result
  result=$(printf '%s' "$payload" | curl -sf -X POST "$GATEWAY_URL/api/memory/import" \
    -H 'content-type: application/json' \
    -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
    --data-binary @-) || {
    echo "✗ Import request failed (check gateway logs)." >&2; exit 1;
  }

  echo "✓ Import complete:"
  printf '%s\n' "$result" | jq -r '
    "    files:            \(.filesTotal)",
    "    stored (embedded):\(.stored)",
    "    skipped existing: \(.skippedExisting)",
    "    deduped in bundle:\(.dedupedInBundle)",
    "    invalid:          \(.invalid | length)",
    "    failed:           \(.failed)"'
  local bad; bad=$(printf '%s' "$result" | jq -r '.invalid | length')
  if [ "$bad" != "0" ]; then
    printf '%s\n' "$result" | jq -r '.invalid[] | "    ! \(.path): \(.error)"'
  fi
}

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  export) cmd_export "$@" ;;
  import) cmd_import "$@" ;;
  ''|help|-h|--help) usage ;;
  *) echo "myai memory: unknown command '$cmd' (expected export|import)" >&2; usage >&2; exit 2 ;;
esac
