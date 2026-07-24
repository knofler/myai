#!/bin/bash
# Hook: Secret Scanner — blocks commits with secrets/API keys/.env files
set +e

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

# Only care about git add and git commit
[[ "$CMD" != *"git add"* && "$CMD" != *"git commit"* ]] && exit 0

# Block staging real .env files (allow .env.example). Match `.env` only as a
# complete filename token — followed by a recognised env suffix or a path/quote/
# whitespace boundary, never by another letter — so legitimate names like
# `.envrc` (direnv) or `setup_org_envrc.sh` do NOT false-positive.
if [[ "$CMD" == *"git add"* ]] \
   && printf '%s' "$CMD" | grep -qE '\.env(\.(local|production|development|test))?($|[[:space:]"'"'"'/])' \
   && ! printf '%s' "$CMD" | grep -qE '\.env\.example'; then
  echo "BLOCKED: .env files must not be staged"; exit 2
fi

# Block staging credentials
[[ "$CMD" == *"git add"*".pem"* ]] && echo "BLOCKED: .pem files must not be staged" && exit 2
[[ "$CMD" == *"git add"*".key"* ]] && echo "BLOCKED: .key files must not be staged" && exit 2

# git add . / -A: check for .env in working tree.
# Use anchored regex so `git add .env.example` (single file) is NOT mistaken
# for `git add .` (everything). Bash glob treats `.` as a literal char that
# matches itself, which caused the previous version to false-positive on
# every single-file stage of a name starting with a dot.
if [[ "$CMD" =~ (^|[[:space:]])"git add ."([[:space:]]|$) ]] || \
   [[ "$CMD" =~ (^|[[:space:]])"git add -A"([[:space:]]|$) ]] || \
   [[ "$CMD" =~ (^|[[:space:]])"git add --all"([[:space:]]|$) ]]; then
  ENV=$(git status --porcelain 2>/dev/null | grep -E '^[ AM?]+\.env$|^[ AM?]+\.env\.(local|production|development|test)$' || true)
  [[ -n "$ENV" ]] && echo "BLOCKED: git add . would stage real .env files" && exit 2
fi

# On commit: check staged .env files
if [[ "$CMD" == *"git commit"* ]]; then
  ENVSTAGED=$(git diff --cached --name-only 2>/dev/null | grep -E '\.env$|\.env\.local$|\.env\.production$|\.env\.development$' || true)
  [[ -n "$ENVSTAGED" ]] && echo "BLOCKED: .env staged for commit" && exit 2

  # Scan for secret patterns. Pattern fragments are concatenated at runtime
  # so this file itself does NOT contain a literal `BEGIN.PRIVATE.KEY`
  # match — earlier versions self-matched during propagation commits because
  # the regex `BEGIN.PRIVATE.KEY` (with `.` as wildcard) matched its own
  # source-text occurrence in the diff.
  # Canonical patterns live in scripts/lib/secret_patterns.sh (shared with the
  # memory-export redactor — ../../scripts/lib resolves in both the master and
  # managed AI/ layouts). Inline copies below are the fallback for repos where
  # the lib hasn't propagated yet — keep them in sync with the lib.
  HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
  . "$HOOK_DIR/../../scripts/lib/secret_patterns.sh" 2>/dev/null || true
  PAT_AWS='AKIA[A-Z0-9]{16}'
  PAT_OPENAI='sk-[a-zA-Z0-9]{48}'
  PAT_GH='ghp_[a-zA-Z0-9]{36}'
  PAT_GCP='AIza[a-zA-Z0-9_-]{35}'
  PAT_PEM='-----BEGIN [A-Z ]+KEY-----'
  # myAI per-tenant API key (ADR-010 §3.6) — myai_live_/myai_test_ + base62 secret.
  # Fragments concatenated so this source line cannot self-match.
  PAT_MYAI="myai_(live|test)_[A-Za-z0-9]""{20,}"
  COMBINED="${SECRET_PAT_COMBINED:-${PAT_AWS}|${PAT_OPENAI}|${PAT_GH}|${PAT_GCP}|${PAT_PEM}|${PAT_MYAI}}"
  SECRETS=$(git diff --cached -U0 2>/dev/null | grep -iE "$COMBINED" || true)
  [[ -n "$SECRETS" ]] && echo "BLOCKED: secrets detected in staged changes" && exit 2
fi

exit 0
