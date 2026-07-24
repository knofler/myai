#!/usr/bin/env bash
# myai_context.sh — full portable CONTEXT bundle export/import (`myai context …`).
#
# This is the "own + download your whole context" command. Where `myai memory`
# ships only the re-embeddable corpus source-text and `myai backup` snapshots
# only the brain + config, `myai context` bundles EVERYTHING an agent needs to
# stand up your context on a fresh machine — into ONE versioned, checksummed,
# secret-scanned, re-importable .tar.gz:
#
#   myai context export [dir] [--repo <name>] [--out <file>] [--quiet]
#                       [--no-brain] [--no-config] [--no-vectors]
#       Assemble and tar a full context bundle:
#
#         myai-context-<host>-<YYYYMMDD-HHMMSS>.tar.gz
#           manifest.json          top-level bundle manifest (kind, version,
#                                  host, per-component counts + sha256 digests)
#           CHECKSUMS.sha256       sha256 of every file — integrity check on import
#           memory/**/*.md         corpus SOURCE TEXT (model-agnostic, re-embeds)
#           memory/manifest.json   the memory-bundle manifest
#           extras/                verbatim state/handoff + pattern-file copies
#           vectors/corpus.json    corpus WITH embeddings (lossless) — present
#                                  only when the gateway exposes /api/vectors/export
#           brain/                 the FULL git-versioned brain repo (.git incl.)
#           config/                top-level ~/.myai config files (redacted)
#
#       Every file is secret-scanned + redacted (same patterns as the commit
#       hook, via lib/secret_patterns.sh) BEFORE the checksum manifest is built,
#       so a bundle never carries a live credential AND its checksums are stable.
#       Skip redaction with MYAI_EXPORT_NO_REDACT=1 (at your own risk).
#
#   myai context import-external <source> [--from <type>] [--repo <name>] …
#       INGEST context FROM A FOREIGN SOURCE (ChatGPT/Claude export, Obsidian
#       vault, markdown/docs folder, raw vector store) — the "bring your existing
#       context to our platform" on-ramp. Each source is converted to provenance
#       markdown and re-embedded on this gateway with dedup-by-hash, tenant-
#       scoped, tagged `source: external`. See `myai context import-external -h`.
#       (Delegates to scripts/myai_context_import.sh.)
#
#   myai context import <archive> [--force] [--with-brain] [--with-config]
#       Verify integrity (CHECKSUMS.sha256) + manifest, then:
#         • memory   → re-embedded on THIS gateway, deduped by hash (always;
#                      idempotent — re-importing is a no-op for overlap)
#         • vectors  → restored losslessly when dims match, else re-embedded
#         • brain    → restored to this machine's brain dir  (--with-brain only)
#         • config   → merged into ~/.myai, never clobbering  (--with-config only)
#       Brain/config restore is OPT-IN because it writes outside the gateway;
#       an existing target is backed up to *.bak (or refuse without --force).
#
# Env: GATEWAY_URL (default http://localhost:3100), GATEWAY_LOCAL_TOKEN (auto),
#      MYAI_HOME (~/.myai), MYAI_BRAIN_DIR / brain.path pointer.
set -euo pipefail

CONTEXT_BUNDLE_KIND="myai-context-bundle"
CONTEXT_BUNDLE_VERSION=1

GATEWAY_URL=${GATEWAY_URL:-http://localhost:3100}
HERE="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=lib/gateway.sh
. "$HERE/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
# shellcheck source=lib/secret_patterns.sh
SECRET_LIB_OK=1
. "$HERE/lib/secret_patterns.sh" 2>/dev/null || SECRET_LIB_OK=0
# brain dir/home resolution (shared lib; inline fallback keeps a partial checkout working)
# shellcheck source=lib/brain.sh
if ! . "$HERE/lib/brain.sh" 2>/dev/null; then
  brain_home() { printf '%s\n' "${MYAI_HOME:-$HOME/.myai}"; }
  brain_dir() {
    if [ -n "${MYAI_BRAIN_DIR:-}" ]; then printf '%s\n' "$MYAI_BRAIN_DIR"; return 0; fi
    local ptr; ptr="$(brain_home)/brain.path"
    if [ -f "$ptr" ]; then local p; p="$(head -1 "$ptr" 2>/dev/null)"; [ -n "$p" ] && { printf '%s\n' "$p"; return 0; }; fi
    printf '%s\n' "$(brain_home)/brain"
  }
fi

usage() { sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "myai context: '$1' is required" >&2; exit 2; }; }
need curl; need jq

# sha256 helper — shasum on macOS, sha256sum on Linux.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

gateway_up() {
  curl -sf -o /dev/null "$GATEWAY_URL/health" 2>/dev/null || {
    echo "✗ Gateway not reachable at $GATEWAY_URL — run 'myai up' first." >&2; exit 1; }
}

# Redact every *.md / *.json / config file under a dir. Echoes redaction count.
redact_tree() {
  local root="$1" redacted=0 hits
  if [ "${MYAI_EXPORT_NO_REDACT:-0}" = "1" ]; then
    echo "  ! MYAI_EXPORT_NO_REDACT=1 — secret scan SKIPPED, bundle may contain live credentials" >&2
    echo 0; return 0
  fi
  if [ "$SECRET_LIB_OK" != "1" ]; then
    echo "✗ lib/secret_patterns.sh not found — refusing to export unscanned bundle." >&2
    echo "  (set MYAI_EXPORT_NO_REDACT=1 to export anyway, at your own risk)" >&2
    exit 1
  fi
  while IFS= read -r -d '' f; do
    if secret_scan_file "$f" >/dev/null; then
      hits=$(secret_redact_file "$f")
      redacted=$((redacted + ${hits:-0}))
      echo "  ! redacted ${hits:-?} secret(s) in ${f#"$root"/}" >&2
    fi
  done < <(find "$root" -type f ! -path '*/.git/*' \
             \( -name '*.md' -o -name '*.json' -o -name 'config' -o -name '*.env' \) -print0)
  echo "$redacted"
}

cmd_export() {
  local dir="" repo="" out="" quiet=0 with_brain=1 with_config=1 with_vectors=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) shift; repo="${1:?--repo needs a value}";;
      --out) shift; out="${1:?--out needs a path}";;
      --quiet|-q) quiet=1;;
      --no-brain) with_brain=0;;
      --no-config) with_config=0;;
      --no-vectors) with_vectors=0;;
      -h|--help) usage; exit 0;;
      -*) echo "myai context export: unknown flag $1" >&2; exit 2;;
      *) dir="$1";;
    esac; shift
  done
  say() { [ "$quiet" = "1" ] || echo "$@"; }
  gateway_up

  local host ts stage
  host="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | sed 's/^-*//;s/-*$//')"
  [ -n "$host" ] || host="host"
  ts="$(date +%Y%m%d-%H%M%S)"
  stage="$(mktemp -d -t myai-context.XXXXXX)"
  trap "rm -rf '$stage'" EXIT

  # ── 1. memory corpus (source text + extras) — reuse myai_memory.sh export ────
  local mem_total=0
  MYAI_EXPORT_NO_REDACT=1 bash "$HERE/myai_memory.sh" export "$stage/memory" \
    ${repo:+--repo "$repo"} >/dev/null 2>&1 || {
      echo "✗ memory export failed (check gateway logs)." >&2; exit 1; }
  # relocate the memory bundle's extras/ to the top level (one extras/ per bundle)
  [ -d "$stage/memory/extras" ] && { mkdir -p "$stage/extras"; cp -R "$stage/memory/extras/." "$stage/extras/"; rm -rf "$stage/memory/extras"; }
  [ -f "$stage/memory/manifest.json" ] && mem_total="$(jq -r '.counts.total // 0' "$stage/memory/manifest.json")"

  # ── 2. vectors WITH embeddings (lossless) — only if gateway exposes it ───────
  local vec_count=0 vec_present=false
  if [ "$with_vectors" = "1" ]; then
    local qs=""; [ -n "$repo" ] && qs="?repo=$(jq -rn --arg v "$repo" '$v|@uri')"
    local corpus
    if corpus=$(curl -sf -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
         "$GATEWAY_URL/api/vectors/export${qs}" 2>/dev/null) \
       && [ -n "$corpus" ] && printf '%s' "$corpus" | jq -e '.kind=="myai-vector-corpus"' >/dev/null 2>&1; then
      mkdir -p "$stage/vectors"
      printf '%s' "$corpus" | jq '.' > "$stage/vectors/corpus.json"
      vec_count="$(jq -r '.count // 0' "$stage/vectors/corpus.json")"
      vec_present=true
    else
      say "  · vectors: gateway has no /api/vectors/export — embeddings skipped (memory/ source text re-embeds on import)"
    fi
  fi

  # ── 3. brain repo (atoms) ────────────────────────────────────────────────────
  local brain brain_present=false brain_head="" brain_sessions=0 brain_memory=0
  brain="$(brain_dir)"
  if [ "$with_brain" = "1" ] && [ -d "$brain" ]; then
    mkdir -p "$stage/brain"
    cp -a "$brain/." "$stage/brain/" 2>/dev/null || cp -R "$brain/." "$stage/brain/"
    brain_present=true
    [ -d "$stage/brain/.git" ] && brain_head="$(git -C "$stage/brain" rev-parse HEAD 2>/dev/null || echo '')"
    brain_sessions="$( { find "$stage/brain/repos" -path '*/sessions/*.md' 2>/dev/null || true; } | wc -l | tr -d ' ')"
    brain_memory="$( { find "$stage/brain/memory" -name '*.md' -not -name '.gitkeep' 2>/dev/null || true; } | wc -l | tr -d ' ')"
  fi

  # ── 4. tenant config (~/.myai top-level files) ───────────────────────────────
  local home_dir config_present=false config_files=0
  home_dir="$(brain_home)"
  if [ "$with_config" = "1" ] && [ -d "$home_dir" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      mkdir -p "$stage/config"; cp -p "$f" "$stage/config/"; config_files=$((config_files + 1))
    done < <(find "$home_dir" -maxdepth 1 -type f 2>/dev/null)
    [ "$config_files" -gt 0 ] && config_present=true
  fi

  # ── 5. secret scan + redact the WHOLE stage (before checksums) ────────────────
  local redacted; redacted="$(redact_tree "$stage")"

  # ── 6. top-level manifest ─────────────────────────────────────────────────────
  local created_at; created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  jq -n \
    --arg kind "$CONTEXT_BUNDLE_KIND" --argjson ver "$CONTEXT_BUNDLE_VERSION" \
    --arg created "$created_at" --arg host "$host" --arg repo "${repo:-}" \
    --argjson memTotal "${mem_total:-0}" \
    --argjson vecPresent "$vec_present" --argjson vecCount "${vec_count:-0}" \
    --argjson brainPresent "$brain_present" --arg brainHead "$brain_head" \
    --argjson brainSessions "${brain_sessions:-0}" --argjson brainMemory "${brain_memory:-0}" \
    --argjson configPresent "$config_present" --argjson configFiles "${config_files:-0}" \
    --argjson redacted "${redacted:-0}" \
    '{kind:$kind, formatVersion:$ver, exportedAt:$created, host:$host,
      repoFilter:(if $repo=="" then null else $repo end),
      redactedSecrets:$redacted,
      components:{
        memory:{present:($memTotal>0), entries:$memTotal},
        vectors:{present:$vecPresent, entries:$vecCount, embeddingsIncluded:$vecPresent},
        brain:{present:$brainPresent, head:$brainHead, sessions:$brainSessions, memory:$brainMemory},
        config:{present:$configPresent, files:$configFiles}}}' \
    > "$stage/manifest.json"

  # ── 7. CHECKSUMS.sha256 (every file except the checksum file itself) ──────────
  ( cd "$stage" && find . -type f ! -name 'CHECKSUMS.sha256' ! -path '*/.git/*' -print0 \
      | LC_ALL=C sort -z \
      | while IFS= read -r -d '' f; do printf '%s  %s\n' "$(sha256_of "$f")" "${f#./}"; done \
    ) > "$stage/CHECKSUMS.sha256"

  # ── 8. tar it up ──────────────────────────────────────────────────────────────
  local archive
  if [ -n "$out" ]; then archive="$out"; mkdir -p "$(dirname "$archive")";
  else
    dir="${dir:-$PWD}"; mkdir -p "$dir"
    archive="$dir/myai-context-$host-$ts.tar.gz"
  fi
  tar -czf "$archive" -C "$stage" .

  local size; size="$(du -h "$archive" 2>/dev/null | cut -f1 | tr -d ' ')"
  if [ "$quiet" = "1" ]; then printf '%s\n' "$archive"; else
    echo "✓ Context bundle written: $archive (${size:-?})"
    echo "  memory:  $mem_total corpus entr$([ "$mem_total" = 1 ] && echo y || echo ies)"
    $vec_present && echo "  vectors: $vec_count embedded (lossless)" || echo "  vectors: source-text only (re-embeds on import)"
    $brain_present && echo "  brain:   ${brain_head:0:8} — $brain_sessions sessions · $brain_memory memory"
    $config_present && echo "  config:  $config_files file(s)"
    [ "${redacted:-0}" -gt 0 ] && echo "  ⚠ $redacted secret(s) redacted — rotate any credential that was live"
    echo "  Import elsewhere with: myai context import $archive"
  fi
}

cmd_import() {
  local archive="" force=0 with_brain=0 with_config=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) force=1;;
      --with-brain) with_brain=1;;
      --with-config) with_config=1;;
      -h|--help) usage; exit 0;;
      -*) echo "myai context import: unknown flag $1" >&2; exit 2;;
      *) archive="$1";;
    esac; shift
  done
  [ -n "$archive" ] || { echo "myai context import: archive required" >&2; usage >&2; exit 2; }
  [ -f "$archive" ] || { echo "myai context import: no such file: $archive" >&2; exit 2; }

  local stage; stage="$(mktemp -d -t myai-context-in.XXXXXX)"; trap "rm -rf '$stage'" EXIT
  tar -xzf "$archive" -C "$stage" 2>/dev/null || { echo "✗ not a readable .tar.gz archive" >&2; exit 2; }

  # ── manifest gate ─────────────────────────────────────────────────────────────
  [ -f "$stage/manifest.json" ] || { echo "✗ bundle has no manifest.json" >&2; exit 2; }
  local kind ver
  kind="$(jq -r '.kind // ""' "$stage/manifest.json")"
  ver="$(jq -r '.formatVersion // 0' "$stage/manifest.json")"
  [ "$kind" = "$CONTEXT_BUNDLE_KIND" ] || { echo "✗ not a $CONTEXT_BUNDLE_KIND (kind=$kind)" >&2; exit 2; }
  [ "$ver" -le "$CONTEXT_BUNDLE_VERSION" ] || { echo "✗ bundle formatVersion $ver newer than supported $CONTEXT_BUNDLE_VERSION" >&2; exit 2; }

  # ── integrity: verify CHECKSUMS.sha256 ────────────────────────────────────────
  if [ -f "$stage/CHECKSUMS.sha256" ]; then
    local bad=0 line hash rel actual
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      hash="${line%%  *}"; rel="${line#*  }"
      [ -f "$stage/$rel" ] || { echo "  ! missing file: $rel" >&2; bad=$((bad+1)); continue; }
      actual="$(sha256_of "$stage/$rel")"
      [ "$actual" = "$hash" ] || { echo "  ! checksum mismatch: $rel" >&2; bad=$((bad+1)); }
    done < "$stage/CHECKSUMS.sha256"
    if [ "$bad" -gt 0 ]; then
      if [ "$force" = "1" ]; then echo "  ⚠ $bad integrity error(s) — continuing (--force)" >&2
      else echo "✗ integrity check failed ($bad file(s)) — refusing import (override with --force)" >&2; exit 3; fi
    else echo "✓ integrity verified ($(grep -c . "$stage/CHECKSUMS.sha256") files)"; fi
  else
    echo "  ⚠ no CHECKSUMS.sha256 in bundle — skipping integrity check" >&2
  fi

  # ── memory re-import (idempotent) ─────────────────────────────────────────────
  if [ -d "$stage/memory" ]; then
    gateway_up
    echo "— memory —"
    bash "$HERE/myai_memory.sh" import "$stage/memory" || echo "  ! memory import failed (continuing)" >&2
  fi

  # ── vectors (lossless) re-import ──────────────────────────────────────────────
  if [ -f "$stage/vectors/corpus.json" ]; then
    gateway_up
    echo "— vectors —"
    local vres
    if vres=$(curl -sf -X POST "$GATEWAY_URL/api/vectors/import" \
        -H 'content-type: application/json' \
        -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
        --data-binary @"$stage/vectors/corpus.json" 2>/dev/null); then
      printf '%s\n' "$vres" | jq -r '
        "    inserted (lossless): \(.insertedWithEmbedding // 0)",
        "    re-embedded:         \(.reEmbedded // 0)",
        "    skipped existing:    \(.skippedExisting // 0)"' 2>/dev/null || true
    else
      echo "  · gateway has no /api/vectors/import — skipped (memory/ already restored the text)" >&2
    fi
  fi

  # ── brain restore (opt-in, guarded) ───────────────────────────────────────────
  if [ "$with_brain" = "1" ] && [ -d "$stage/brain" ]; then
    echo "— brain —"
    local target; target="$(brain_dir)"
    if [ -d "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
      if [ "$force" = "1" ]; then
        mv "$target" "$target.bak.$(date +%s)"; echo "  existing brain → backed up to *.bak"
      else
        echo "  ! brain dir $target is non-empty — skipping (use --force to back up + replace)" >&2
      fi
    fi
    if [ ! -d "$target" ] || [ -z "$(ls -A "$target" 2>/dev/null)" ]; then
      mkdir -p "$target"; cp -a "$stage/brain/." "$target/" 2>/dev/null || cp -R "$stage/brain/." "$target/"
      echo "  ✓ brain restored → $target"
    fi
  fi

  # ── config restore (opt-in, merge-never-clobber) ──────────────────────────────
  if [ "$with_config" = "1" ] && [ -d "$stage/config" ]; then
    echo "— config —"
    local home_dir; home_dir="$(brain_home)"; mkdir -p "$home_dir"
    local n=0
    while IFS= read -r -d '' f; do
      local base; base="$(basename "$f")"
      if [ -e "$home_dir/$base" ] && [ "$force" != "1" ]; then
        echo "  · $base exists — kept (use --force to overwrite, existing→*.bak)"
      else
        [ -e "$home_dir/$base" ] && cp -p "$home_dir/$base" "$home_dir/$base.bak"
        cp -p "$f" "$home_dir/$base"; n=$((n+1))
      fi
    done < <(find "$stage/config" -maxdepth 1 -type f -print0)
    echo "  ✓ $n config file(s) restored → $home_dir"
  fi

  echo "✓ Context import complete."
}

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  export) cmd_export "$@" ;;
  import) cmd_import "$@" ;;
  import-external|ingest) exec bash "$HERE/myai_context_import.sh" "$@" ;;
  ''|help|-h|--help) usage ;;
  *) echo "myai context: unknown command '$cmd' (expected export|import|import-external)" >&2; usage >&2; exit 2 ;;
esac
