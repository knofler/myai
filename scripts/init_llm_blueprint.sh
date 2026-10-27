#!/usr/bin/env bash
# init_llm_blueprint.sh — scaffold an "LLM from scratch" learning project.
#
#   ./scripts/init_llm_blueprint.sh ~/Dev/my-llm
#   ./scripts/init_llm_blueprint.sh ~/Dev/my-llm --gh-create <owner>/my-llm [--gh-private]
#
# WHAT YOU GET: a complete, deployable pipeline for a small language model with
# the model itself deliberately UNBUILT. `./dev up` works on a fresh clone —
# tokenizer, data, model, training loop, HTTP API and chat page all run — but
# every one of those is a trivial placeholder. Eight staged exercises replace
# them one at a time, and the pipeline keeps running the whole way.
#
# WHY IT IS SHAPED LIKE THIS (operator directive 2026-09-16, D8): "I want to
# learn building LLM from scratch and I will build a simple LLM so I can use
# and understand how it works end to end, you don't build it at all, start the
# full end to end deployable framework, then we or the local agent
# interactively build it to the point I learn and use."
#
# So: the FRAMEWORK is finished and the LEARNING is not. Do not implement the
# stages for the operator. `PROMPTS.md` in the scaffold exists to keep an agent
# in review-and-explain mode rather than author mode.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$ROOT/templates/blueprint-llm"

TARGET="" GH_SLUG="" GH_PRIVATE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --gh-create)  shift; GH_SLUG="${1:?--gh-create needs owner/repo}" ;;
    --gh-private) GH_PRIVATE="--private" ;;
    -h|--help)    grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "init_llm_blueprint: unknown flag: $1" >&2; exit 2 ;;
    *)  TARGET="$1" ;;
  esac
  shift
done

[ -n "$TARGET" ] || { echo "usage: ./scripts/init_llm_blueprint.sh <path> [--gh-create owner/repo]" >&2; exit 2; }
[ -d "$TEMPLATE" ] || { echo "init_llm_blueprint: template missing at $TEMPLATE" >&2; exit 1; }

# Refuse to scribble into a non-empty directory — that is how people lose work.
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "init_llm_blueprint: $TARGET exists and is not empty — refusing." >&2
  exit 1
fi

NAME="$(basename "$TARGET")"
mkdir -p "$TARGET"
# `/.` so the dot-prefixed entries come too (.gitignore, .dockerignore).
cp -a "$TEMPLATE/." "$TARGET/"

# PROJECT_NAME must equal the folder name: the framework's Docker naming rule
# requires every container_name to carry the exact folder name as its prefix.
if [ -f "$TARGET/env.example" ]; then
  sed -i.bak "s/^PROJECT_NAME=.*/PROJECT_NAME=$NAME/" "$TARGET/env.example"
  rm -f "$TARGET/env.example.bak"
  cp "$TARGET/env.example" "$TARGET/.env"
fi

mkdir -p "$TARGET/checkpoints" "$TARGET/AI/state"

# Onboarding marker, same mechanism as init_blueprint.sh's .awaiting-app-idea:
# the first `agent mode` in the new repo reads this and starts the curriculum
# conversation instead of guessing at the project.
cat > "$TARGET/AI/state/.awaiting-llm-curriculum" <<MARKER
project:   $NAME
kind:      llm-from-scratch (learning blueprint)
scaffolded: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
template:  templates/blueprint-llm

THE RULE FOR WHICHEVER AGENT READS THIS FIRST:
  Do NOT implement the eight stages. The operator is building this to LEARN.
  Your job is to explain, review what they wrote, quiz them, and give hint
  ladders — never to author train/llm/*.py. See PROMPTS.md.

  Start by running \`./dev up\` then \`./dev stage\`, and walk the operator
  into Stage 1 (tokenization) from CURRICULUM.md.
MARKER

if [ ! -d "$TARGET/.git" ]; then
  git -C "$TARGET" init -q
  git -C "$TARGET" add -A
  git -C "$TARGET" commit -qm "chore: scaffold LLM-from-scratch learning blueprint

Pipeline complete, model deliberately unbuilt. Eight staged exercises in
CURRICULUM.md; \`./dev stage\` tracks position." || true
fi

if [ -n "$GH_SLUG" ] && command -v gh >/dev/null 2>&1; then
  echo "→ creating github repo $GH_SLUG…"
  ( cd "$TARGET" && gh repo create "$GH_SLUG" $GH_PRIVATE --source=. --push \
      --description "LLM from scratch — a learning blueprint" ) 2>&1 | tail -3
fi

cat <<DONE

  LLM-from-scratch blueprint scaffolded.

    path:     $TARGET
    stages:   0/8 implemented (every one a running placeholder)
    next:     cd $TARGET && ./dev up && ./dev stage

  The pipeline already works end to end — train, serve and chat all run, and
  produce meaningless output on purpose. Read CURRICULUM.md, then Stage 1.

  Work it with an agent in REVIEW mode, not author mode: PROMPTS.md has
  prompts phrased to get explanation instead of code. The one way to waste
  this scaffold is to have something else fill in the eight files for you.

DONE
