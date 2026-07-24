#!/bin/bash
set +e
# Hook: MongoDB Atlas Connectivity Check
# Event: SessionStart (on-demand)
# Verifies Atlas connection and reports collection stats

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Try to find MongoDB URI from .env files
ENV_FILE=""
for f in "$ROOT/.env" "$ROOT/.env.local"; do
  if [ -f "$f" ]; then
    ENV_FILE="$f"
    break
  fi
done

if [ -z "$ENV_FILE" ]; then
  echo "No .env file found — skipping Atlas check"
  exit 0
fi

# NOTE: no `grep -oP` here — macOS BSD grep has no -P, so \K silently matched
# nothing and this hook false-negatived ("No MONGODB_URI") on every Mac.
MONGO_URI=$(grep -E '^MONGODB_URI=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")

if [ -z "$MONGO_URI" ]; then
  echo "No MONGODB_URI in $ENV_FILE — skipping Atlas check"
  exit 0
fi

# Check if mongosh is available
if ! command -v mongosh &>/dev/null; then
  echo "mongosh not installed — cannot verify Atlas connectivity"
  echo "Install with: brew install mongosh"
  exit 0
fi

# Test connectivity with 5s timeout
RESULT=$(mongosh "$MONGO_URI" --quiet --eval '
  const colls = db.getCollectionNames();
  const counts = {};
  colls.forEach(c => { counts[c] = db[c].estimatedDocumentCount(); });
  JSON.stringify({ connected: true, database: db.getName(), collections: colls.length, counts });
' 2>&1 | tail -1)

if echo "$RESULT" | jq . &>/dev/null; then
  DB=$(echo "$RESULT" | jq -r '.database')
  COLLS=$(echo "$RESULT" | jq -r '.collections')
  echo "Atlas: Connected to '$DB' ($COLLS collections)"
  echo "$RESULT" | jq -r '.counts | to_entries[] | "  \(.key): \(.value) docs"' 2>/dev/null | head -10
else
  echo "ATLAS CONNECTION FAILED:"
  echo "$RESULT" | tail -3
fi

exit 0
