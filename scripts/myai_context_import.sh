#!/usr/bin/env bash
# myai_context_import.sh — ingest context FROM EXTERNAL sources
# (`myai context import-external <source>`).
#
# CONTEXT-PORT 2 — the "bring your existing context to our platform" on-ramp.
# Where `myai context import <archive>` restores YOUR OWN exported bundle, this
# adapter pulls context INTO your brain+vectors from *foreign* tools:
#
#   myai context import-external <source> [--from <type>] [--repo <name>]
#                                [--as <vector-source>] [--tag <t>]…
#                                [--dry-run] [--out <dir>] [--quiet]
#
#     <source>  a file or directory to ingest. --from auto-detects when omitted:
#       chatgpt   ChatGPT data export  (conversations.json — OpenAI `mapping`)
#       claude    Claude data export   (conversations.json — `chat_messages`)
#       obsidian  an Obsidian vault    (dir of .md, incl. nested notes)
#       markdown  a plain docs folder  (dir of .md/.markdown/.mdx/.txt) or one file
#       vectors   a raw vector store   (myai-vector-corpus → mapped losslessly;
#                                       any {text|content|page_content,…} array
#                                       → re-embedded on THIS gateway)
#
#   Every adapter converts the source into provenance-frontmatter markdown and
#   hands it to the SAME re-embedding path `myai memory import` uses, so imported
#   context is: re-embedded on this gateway, deduplicated by content hash
#   (re-running is a no-op for overlap), and tenant-scoped. Imported entries get
#   `source: external` (override with --as) so they stay attributable/filterable
#   apart from the framework's own corpus.
#
#   --repo   tenant/repo scope for the imported entries (default: derived from
#            the source name). --as sets the vector `source` field. --tag adds a
#            tag (repeatable; `imported` + the adapter type are always added).
#   --dry-run  build the staged markdown + print a summary, DO NOT import
#              (works with no gateway — the offline preview / test path).
#   --out <dir>  keep the staged markdown here (default: a temp dir, cleaned up).
#
# Env: GATEWAY_URL (default http://localhost:3100), GATEWAY_LOCAL_TOKEN (auto).
set -euo pipefail

GATEWAY_URL=${GATEWAY_URL:-http://localhost:3100}
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/gateway.sh
. "$HERE/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

usage() { sed -n '2,44p' "$0" | sed 's/^# \{0,1\}//'; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "myai context import-external: '$1' is required" >&2; exit 2; }; }
need jq

# ── args ──────────────────────────────────────────────────────────────────────
SRC="" FROM="auto" REPO="" AS="external" OUT="" DRY=0 QUIET=0
TAGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --from) shift; FROM="${1:?--from needs a value}";;
    --repo) shift; REPO="${1:?--repo needs a value}";;
    --as) shift; AS="${1:?--as needs a value}";;
    --tag) shift; TAGS+=("${1:?--tag needs a value}");;
    --out) shift; OUT="${1:?--out needs a path}";;
    --dry-run|-n) DRY=1;;
    --quiet|-q) QUIET=1;;
    -h|--help) usage; exit 0;;
    -*) echo "myai context import-external: unknown flag $1" >&2; exit 2;;
    *) SRC="$1";;
  esac; shift
done
[ -n "$SRC" ] || { echo "myai context import-external: <source> required" >&2; usage >&2; exit 2; }
[ -e "$SRC" ] || { echo "myai context import-external: no such file or dir: $SRC" >&2; exit 2; }

say() { [ "$QUIET" = "1" ] || echo "$@"; }

# slugify → lowercase, non-alnum → '-', collapse, trim, cap length
slug() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' \
           | sed 's/-\{2,\}/-/g;s/^-*//;s/-*$//' | cut -c1-60; }

# derive a default repo/tenant scope from the source name
default_repo() {
  local b; b="$(basename "$SRC")"; b="${b%.json}"; b="${b%.tar.gz}"
  local s; s="$(slug "$b")"; [ -n "$s" ] || s="imported"
  printf 'import-%s' "$s"
}
[ -n "$REPO" ] || REPO="$(default_repo)"

# ── auto-detect source type ─────────────────────────────────────────────────────
detect_from() {
  if [ -d "$SRC" ]; then
    if [ -f "$SRC/conversations.json" ]; then detect_json "$SRC/conversations.json"; return; fi
    if [ -d "$SRC/.obsidian" ]; then echo obsidian; return; fi
    echo markdown; return
  fi
  case "$SRC" in
    *.md|*.markdown|*.mdx|*.txt) echo markdown; return;;
    *.json) detect_json "$SRC"; return;;
  esac
  # fall back: readable text → markdown
  echo markdown
}
# peek a .json and classify chatgpt | claude | vectors | markdown(unknown)
detect_json() {
  local f="$1" k
  k="$(jq -r '
    if type=="object" and .kind=="myai-vector-corpus" then "vectors"
    elif (type=="array" and (.[0]|type=="object") and (.[0]|has("mapping"))) then "chatgpt"
    elif (type=="object" and has("mapping")) then "chatgpt"
    elif (type=="array" and (.[0]|type=="object") and (.[0]|has("chat_messages"))) then "claude"
    elif (type=="object" and has("chat_messages")) then "claude"
    elif (type=="array" and (.[0]|type=="object") and ((.[0]|has("embedding")) or (.[0]|has("text")) or (.[0]|has("content")) or (.[0]|has("page_content")))) then "vectors"
    else "unknown" end' "$f" 2>/dev/null)" || k="unknown"
  echo "$k"
}
[ "$FROM" = "auto" ] && FROM="$(detect_from)"
case "$FROM" in
  chatgpt|claude|obsidian|markdown|vectors) : ;;
  unknown) echo "✗ could not auto-detect source type — pass --from chatgpt|claude|obsidian|markdown|vectors" >&2; exit 2;;
  *) echo "✗ unknown --from '$FROM' (chatgpt|claude|obsidian|markdown|vectors)" >&2; exit 2;;
esac

# ── staging dir ─────────────────────────────────────────────────────────────────
if [ -n "$OUT" ]; then STAGE="$OUT"; mkdir -p "$STAGE";
else STAGE="$(mktemp -d -t myai-ctx-ext.XXXXXX)"; trap "rm -rf '$STAGE'" EXIT; fi
SAFE_REPO="$(printf '%s' "$REPO" | tr -c 'a-zA-Z0-9._-' '_')"
MEM_DIR="$STAGE/memory/$SAFE_REPO"; mkdir -p "$MEM_DIR"

# tags array (always: imported + adapter type)
tag_json() {
  local all=("imported" "$FROM")
  [ "${#TAGS[@]}" -gt 0 ] && all+=("${TAGS[@]}")
  printf '%s\n' "${all[@]}" | jq -R . | jq -cs .
}
TAGS_JSON="$(tag_json)"

# Write ONE staged markdown entry. Args: session-slug, created-iso, meta-json, body.
# Frontmatter is kept simple + safe; the messy bits (title, origin) live in
# metadataJson (JSON, single-quote-escaped for YAML). Body is written verbatim.
WRITTEN=0
write_entry() {
  local sslug="$1" created="$2" meta="$3" body="$4"
  [ -n "$body" ] || return 0
  # unique, stable filename: slug + short hash of body
  local h; h="$(printf '%s' "$body" | { command -v sha256sum >/dev/null 2>&1 \
        && sha256sum || shasum -a 256; } | awk '{print $1}' | cut -c1-12)"
  local base; base="$(slug "$sslug")"; [ -n "$base" ] || base="entry"
  local file="$MEM_DIR/${base}-${h}.md"
  local meta_yaml; meta_yaml="$(printf '%s' "$meta" | sed "s/'/''/g")"
  {
    printf -- '---\n'
    printf 'repo: %s\n' "$REPO"
    printf 'source: %s\n' "$AS"
    printf 'tags: %s\n' "$TAGS_JSON"
    printf 'sessionId: %s\n' "$base"
    [ -n "$created" ] && printf 'createdAt: %s\n' "$created"
    printf "metadataJson: '%s'\n" "$meta_yaml"
    printf -- '---\n'
    printf '%s\n' "$body"
  } > "$file"
  WRITTEN=$((WRITTEN + 1))
}

# ── adapters ────────────────────────────────────────────────────────────────────

adapt_chatgpt() {
  local f="$SRC"; [ -d "$SRC" ] && f="$SRC/conversations.json"
  [ -f "$f" ] || { echo "✗ chatgpt: no conversations.json at $f" >&2; exit 2; }
  # Emit one base64(JSON) line per conversation: {title, created, body}.
  jq -r '
    (if type=="array" then . else (.conversations // [.]) end)[]
    | . as $c
    | {
        title: ($c.title // "ChatGPT conversation"),
        created: ((($c.create_time // 0) | if . > 0 then (floor|todate) else "" end)),
        body: ([ ($c.mapping // {}) | to_entries[] | .value.message
                  | select(. != null)
                  | { role: (.author.role // "unknown"),
                      t: (.create_time // 0),
                      text: ((.content.parts // []) | map(select(type=="string")) | join("\n")) }
                  | select((.text|length) > 0) ]
               | sort_by(.t)
               | map("**\(.role)**: \(.text)") | join("\n\n"))
      }
    | select((.body|length) > 0)
    | @base64
  ' "$f" | while IFS= read -r b64; do
    [ -n "$b64" ] || continue
    local obj title created body meta
    obj="$(printf '%s' "$b64" | base64 -d)"
    title="$(printf '%s' "$obj" | jq -r '.title')"
    created="$(printf '%s' "$obj" | jq -r '.created')"
    body="$(printf '%s' "$obj" | jq -j '.body')"
    meta="$(jq -cn --arg t "$title" --arg o chatgpt '{origin:$o, title:$t, importedFrom:"conversations.json"}')"
    write_entry "$title" "$created" "$meta" "$body"
  done
}

adapt_claude() {
  local f="$SRC"; [ -d "$SRC" ] && f="$SRC/conversations.json"
  [ -f "$f" ] || { echo "✗ claude: no conversations.json at $f" >&2; exit 2; }
  jq -r '
    (if type=="array" then . else (.conversations // [.]) end)[]
    | . as $c
    | {
        title: ($c.name // $c.title // "Claude conversation"),
        created: ($c.created_at // ""),
        body: ([ ($c.chat_messages // []) []
                  | { role: (.sender // "unknown"),
                      text: ( .text
                              // ((.content // []) | map(select(.type=="text") | .text) | join("\n"))
                              // "" ) }
                  | select((.text|length) > 0)
                  | "**\(.role)**: \(.text)" ] | join("\n\n"))
      }
    | select((.body|length) > 0)
    | @base64
  ' "$f" | while IFS= read -r b64; do
    [ -n "$b64" ] || continue
    local obj title created body meta
    obj="$(printf '%s' "$b64" | base64 -d)"
    title="$(printf '%s' "$obj" | jq -r '.title')"
    created="$(printf '%s' "$obj" | jq -r '.created')"
    body="$(printf '%s' "$obj" | jq -j '.body')"
    meta="$(jq -cn --arg t "$title" --arg o claude '{origin:$o, title:$t, importedFrom:"conversations.json"}')"
    write_entry "$title" "$created" "$meta" "$body"
  done
}

# obsidian + markdown share the same file-walk; obsidian just also skips the
# .obsidian/ config dir.
adapt_markdown_tree() {
  local root="$SRC"
  if [ -f "$SRC" ]; then
    local body meta rel
    body="$(cat "$SRC")"
    rel="$(basename "$SRC")"
    meta="$(jq -cn --arg t "$rel" --arg o "$FROM" '{origin:$o, title:$t, importedFrom:$t}')"
    write_entry "${rel%.*}" "" "$meta" "$body"
    return 0
  fi
  local f rel body meta title
  while IFS= read -r -d '' f; do
    body="$(cat "$f")"
    [ -n "$body" ] || continue
    rel="${f#"$root"/}"
    title="$(basename "$rel")"; title="${title%.*}"
    meta="$(jq -cn --arg t "$title" --arg p "$rel" --arg o "$FROM" \
              '{origin:$o, title:$t, importedFrom:$p}')"
    # slug from the relative path so nested notes don't collide
    write_entry "$(printf '%s' "$rel" | sed 's/\.[^.]*$//')" "" "$meta" "$body"
  done < <(find "$root" -type f ! -path '*/.obsidian/*' ! -path '*/.git/*' \
             \( -name '*.md' -o -name '*.markdown' -o -name '*.mdx' -o -name '*.txt' \) -print0)
}

# vectors: myai-vector-corpus → POST to /api/vectors/import (lossless/map).
# any other array → extract text and re-embed via the staged-markdown path.
IS_CORPUS=0
adapt_vectors() {
  local f="$SRC"; [ -d "$SRC" ] && f="$SRC/vectors.json"
  [ -f "$f" ] || { echo "✗ vectors: no such json: $f" >&2; exit 2; }
  if jq -e '.kind=="myai-vector-corpus"' "$f" >/dev/null 2>&1; then
    IS_CORPUS=1; VEC_CORPUS_FILE="$f"; return 0
  fi
  # generic vector store: one entry per record, extract the human text.
  jq -r '
    (if type=="array" then . else (.vectors // .entries // .documents // [.]) end)[]
    | { text: ( .text // .content // .page_content // .document // .body // (.metadata.text // "") ),
        title: ( .title // .id // (.metadata.title // "vector") ),
        meta: ( (.metadata // {}) + { source: (.source // "vectors") } ) }
    | select((.text|type=="string") and (.text|length) > 0)
    | @base64
  ' "$f" | while IFS= read -r b64; do
    [ -n "$b64" ] || continue
    local obj text title meta
    obj="$(printf '%s' "$b64" | base64 -d)"
    text="$(printf '%s' "$obj" | jq -j '.text')"
    title="$(printf '%s' "$obj" | jq -r '.title')"
    meta="$(printf '%s' "$obj" | jq -c '{origin:"vectors", title:.title, metadata:.meta}')"
    write_entry "$title" "" "$meta" "$text"
  done
}

case "$FROM" in
  chatgpt)  adapt_chatgpt ;;
  claude)   adapt_claude ;;
  obsidian) adapt_markdown_tree ;;
  markdown) adapt_markdown_tree ;;
  vectors)  adapt_vectors ;;
esac

# ── lossless corpus fast-path (vectors) ─────────────────────────────────────────
if [ "$IS_CORPUS" = "1" ]; then
  say "→ source is a myai-vector-corpus — mapping via /api/vectors/import"
  if [ "$DRY" = "1" ]; then
    corpus_count="$(jq -r '.count // (.entries|length) // 0' "$VEC_CORPUS_FILE")"
    say "  [dry-run] would import $corpus_count corpus entries (lossless when dims match, else re-embed)"
    exit 0
  fi
  curl -sf -o /dev/null "$GATEWAY_URL/health" 2>/dev/null || { echo "✗ Gateway not reachable at $GATEWAY_URL — run 'myai up'." >&2; exit 1; }
  res="$(curl -sf -X POST "$GATEWAY_URL/api/vectors/import" \
      -H 'content-type: application/json' \
      -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
      --data-binary @"$VEC_CORPUS_FILE" 2>/dev/null)" || {
    echo "✗ /api/vectors/import failed (needs a gateway rebuild if the route is absent)." >&2; exit 1; }
  printf '%s\n' "$res" | jq -r '
    "✓ vector corpus imported:",
    "    inserted (lossless): \(.insertedWithEmbedding // 0)",
    "    re-embedded:         \(.reEmbedded // 0)",
    "    skipped existing:    \(.skippedExisting // 0)"' 2>/dev/null || printf '%s\n' "$res"
  exit 0
fi

# ── summary + handoff to memory import (re-embed + dedup-by-hash + tenant-scope) ─
# Adapters write inside a `jq | while` pipe (a subshell), so the WRITTEN counter
# doesn't survive to here — count the staged files on disk instead (robust).
WRITTEN="$(find "$MEM_DIR" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
if [ "$WRITTEN" = "0" ]; then
  echo "✗ nothing to import — no usable content found in $SRC (from=$FROM)" >&2
  exit 4
fi
say "→ staged $WRITTEN entr$([ "$WRITTEN" = 1 ] && echo y || echo ies) from '$FROM' → repo '$REPO' (source=$AS)"

if [ "$DRY" = "1" ]; then
  say "  [dry-run] staged markdown in: $STAGE"
  say "  [dry-run] NOT imported — re-run without --dry-run to re-embed on the gateway"
  # in dry-run with --out, leave the files; otherwise print the tree for visibility
  [ -z "$OUT" ] && find "$STAGE/memory" -type f -name '*.md' | sed 's/^/    /'
  exit 0
fi

say "→ re-embedding on gateway (dedup-by-hash, tenant-scoped) …"
bash "$HERE/myai_memory.sh" import "$STAGE"
