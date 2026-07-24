#!/usr/bin/env bash
# brain.sh — Brain store core: git-versioned agent memory (BRAIN B1).
#
# The brain is a real, private git repo SEPARATE from code git (see
# plan/jam/brain-layer.md). Sessions = commits, wrap up = merge, branches =
# parallel thinking contexts, `main` = the consolidated truth agents boot from.
#
# Layout inside the brain repo:
#   BRAIN.md                          manifest (created by init)
#   memory/<atom>.md                  cross-repo memory facts
#   repos/<name>/sessions/<atom>.md   one file per session block
#   repos/<name>/handoffs/<atom>.md   one file per handoff entry
#   repos/<name>/brief.md             compiled boot brief  (~150 tok, checked into main)
#   repos/<name>/working.md           compiled working context (~2k, checked into main)
#
# APPEND-ONLY ATOMS: every session block / handoff entry / memory fact is ONE
# file, immutable once written. Filenames embed a content hash
# (<utc-ts>-<host>-<slug>-<sha8>.md) so two agents can never race on the same
# path with different content — git merges are conflict-free BY CONSTRUCTION.
# The lib NEVER edits an existing atom; re-writing an identical fact is a
# no-op (dedup by <slug>-<sha8> within the target dir).
#
# Branch model:
#   main                              consolidated truth
#   session/<YYYYMMDD>-<host>-<prof>  auto, short-lived, merges at wrap up
#   idea/<slug>                       long-lived parallel thought
#
# Resolution order for the brain location (bash + node libs agree):
#   1. $MYAI_BRAIN_DIR                explicit override
#   2. $MYAI_HOME/brain.path          pointer file written by `brain init`
#   3. $MYAI_HOME/brain               default ($MYAI_HOME defaults to ~/.myai)
#
# Sourceable (set-e/-u safe, bash 3.2-safe for stock macOS). CLI wrapper:
# scripts/myai_brain.sh. Node mirror: runtime/src/core/brain.ts. Tests:
# scripts/tests/test_brain.sh (hermetic — git + coreutils only).

# ── location resolution ──────────────────────────────────────────────────────

brain_home() { printf '%s\n' "${MYAI_HOME:-$HOME/.myai}"; }

brain_dir() {
  if [ -n "${MYAI_BRAIN_DIR:-}" ]; then printf '%s\n' "$MYAI_BRAIN_DIR"; return 0; fi
  local ptr; ptr="$(brain_home)/brain.path"
  if [ -f "$ptr" ]; then
    local p; p="$(head -1 "$ptr" 2>/dev/null)"
    if [ -n "$p" ]; then printf '%s\n' "$p"; return 0; fi
  fi
  printf '%s\n' "$(brain_home)/brain"
}

brain_is_repo() { local d="${1:-$(brain_dir)}"; [ -d "$d/.git" ] && [ -f "$d/BRAIN.md" ]; }

brain_git() { git -C "$(brain_dir)" "$@"; }

brain_host() {
  local h="${BRAIN_HOST:-$(hostname -s 2>/dev/null || echo unknown)}"
  printf '%s\n' "$h" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | sed 's/^-*//;s/-*$//'
}

_brain_slugify() {
  printf '%s\n' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' \
    | sed 's/--*/-/g;s/^-*//;s/-*$//'
}

_brain_sha8() {
  # sha256 of stdin, first 8 hex chars. macOS ships shasum, Linux sha256sum.
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-8
  else shasum -a 256 | cut -c1-8; fi
}

_brain_utc() { date -u +%Y%m%dT%H%M%SZ; }

# ── remote auto-sync (push-on-merge / pull-on-boot) ──────────────────────────
#
# When the brain has an `origin` remote (e.g. a private github.com repo), sync
# is INVISIBLE: merges and stashes push main, session boots do a bounded
# fast-fail fetch + ff-only pull. Every network op is NON-FATAL — offline stays
# first-class (documentation/BRAIN_OFFLINE.md); a failed push/pull just means
# "sync next time". Bound: $BRAIN_NET_TIMEOUT seconds (default 2).
# Node mirror: brainSyncPush/brainSyncPull in runtime/src/core/brain.ts.

brain_remote_url() { git -C "${1:-$(brain_dir)}" remote get-url origin 2>/dev/null; }

# _brain_net_git <dir> <args…> — a network git op against the brain, bounded so
# an unreachable host can never hang a session boot. Prefers timeout/gtimeout;
# otherwise falls back to git-level connect/low-speed limits.
_brain_net_git() {
  local d="$1" t="${BRAIN_NET_TIMEOUT:-2}"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$t" git -C "$d" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$t" git -C "$d" "$@"
  else
    GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o ConnectTimeout=$t -o BatchMode=yes" \
      git -C "$d" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime="$t" "$@"
  fi
}

# brain_sync_push — push main to origin. No remote → silent no-op. Always rc 0.
brain_sync_push() {
  local d; d="$(brain_dir)"
  brain_remote_url "$d" >/dev/null || return 0
  if _brain_net_git "$d" push -q origin main >/dev/null 2>&1; then
    echo "brain: pushed main to origin" >&2
  else
    echo "brain: push to origin failed (offline?) — will sync on the next merge/stash" >&2
  fi
  return 0
}

# brain_sync_pull — bounded fetch + ff-only advance of local main. Never merges
# or rebases: diverged/dirty → no-op (the next push-on-merge reconciles). No
# remote → silent no-op. Always rc 0.
brain_sync_pull() {
  local d; d="$(brain_dir)"
  brain_remote_url "$d" >/dev/null || return 0
  if ! _brain_net_git "$d" fetch -q origin main >/dev/null 2>&1; then
    echo "brain: fetch from origin failed (offline?) — reading local main" >&2
    return 0
  fi
  local cur; cur="$(git -C "$d" rev-parse --abbrev-ref HEAD)"
  if [ "$cur" = "main" ]; then
    if [ -z "$(git -C "$d" status --porcelain)" ]; then
      git -C "$d" merge -q --ff-only origin/main >/dev/null 2>&1 || true
    fi
  else
    # main not checked out → ff-only ref update (git refuses non-ff without +).
    git -C "$d" fetch -q . refs/remotes/origin/main:refs/heads/main >/dev/null 2>&1 || true
  fi
  return 0
}

# ── init ─────────────────────────────────────────────────────────────────────

# brain_init [path] [--remote <url>]
# Creates the brain git repo (branch: main), seeds the layout, records the
# pointer file so every agent/lib on this machine resolves the same brain.
# Idempotent: an existing brain is adopted (pointer refreshed, remote added if
# missing), never re-initialized. --remote + no local dir → CLONE the remote
# (one-command adoption on a new machine); an empty/unreachable remote falls
# back to a fresh init, and a fresh init with a remote pushes main (non-fatal).
brain_init() {
  local dir="" remote="" arg
  while [ $# -gt 0 ]; do
    arg="$1"; shift
    case "$arg" in
      --remote) remote="${1:-}"; shift ;;
      -*) echo "brain_init: unknown option: $arg" >&2; return 2 ;;
      *) dir="$arg" ;;
    esac
  done
  [ -n "$dir" ] || dir="$(brain_home)/brain"
  case "$dir" in /*) ;; *) dir="$(pwd)/$dir" ;; esac

  mkdir -p "$(brain_home)"
  if brain_is_repo "$dir"; then
    printf '%s\n' "$dir" > "$(brain_home)/brain.path"
    if [ -n "$remote" ] && ! git -C "$dir" remote get-url origin >/dev/null 2>&1; then
      git -C "$dir" remote add origin "$remote"
    fi
    echo "brain: already initialized at $dir"
    return 0
  fi

  # Remote given + no local dir → CLONE (new-machine adoption in one command;
  # previously this was a manual `git clone`). A clone that doesn't produce a
  # brain repo (empty remote) or fails (unreachable) falls through to fresh init.
  if [ -n "$remote" ] && [ ! -e "$dir" ]; then
    if git clone -q "$remote" "$dir" >/dev/null 2>&1 && brain_is_repo "$dir"; then
      git -C "$dir" config user.name  "myai-brain"
      git -C "$dir" config user.email "brain@myai.local"
      git -C "$dir" config commit.gpgsign false
      printf '%s\n' "$dir" > "$(brain_home)/brain.path"
      echo "brain: cloned from $remote to $dir (branch: main)"
      return 0
    fi
    # Clone of an EMPTY remote leaves a commit-less repo — pin HEAD to main so
    # the fresh-init path below seeds the layout on the right branch.
    if [ -d "$dir/.git" ] && ! git -C "$dir" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
      git -C "$dir" symbolic-ref HEAD refs/heads/main 2>/dev/null || true
    fi
  fi

  if [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ] && [ ! -d "$dir/.git" ]; then
    echo "brain_init: $dir exists and is not empty (and not a brain repo) — refusing" >&2
    return 1
  fi

  mkdir -p "$dir/memory" "$dir/repos"
  ( cd "$dir" && git init -q -b main 2>/dev/null ) \
    || ( cd "$dir" && git init -q && git symbolic-ref HEAD refs/heads/main )
  # Local identity so headless/runner commits never depend on global git config.
  git -C "$dir" config user.name  "myai-brain"
  git -C "$dir" config user.email "brain@myai.local"
  git -C "$dir" config commit.gpgsign false

  cat > "$dir/BRAIN.md" <<'EOF'
# myAI Brain

Git-versioned agent memory. Sessions = commits, wrap up = merge, `main` = the
consolidated truth every agent boots from.

- `memory/` — cross-repo memory facts (append-only atoms)
- `repos/<name>/sessions/` — session blocks (append-only atoms)
- `repos/<name>/handoffs/` — handoff entries (append-only atoms)
- `repos/<name>/brief.md` — compiled boot brief (~150 tokens)
- `repos/<name>/working.md` — compiled working context (~2k tokens)

Atoms are immutable once written — never edit them; write a new atom.
Compiled artifacts (`brief.md`, `working.md`) are regenerated by the distiller
(`brain merge`) and are the ONLY files here that change in place.

Managed by `myai brain` (scripts/lib/brain.sh · runtime/src/core/brain.ts).
EOF
  touch "$dir/memory/.gitkeep" "$dir/repos/.gitkeep"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m "brain: init store (layout v1)"
  if [ -n "$remote" ] && ! git -C "$dir" remote get-url origin >/dev/null 2>&1; then
    git -C "$dir" remote add origin "$remote"
  fi

  printf '%s\n' "$dir" > "$(brain_home)/brain.path"
  # First machine ever: seed the remote right away (non-fatal — offline just
  # means the next merge/stash pushes instead).
  if [ -n "$remote" ]; then
    _brain_net_git "$dir" push -q -u origin main >/dev/null 2>&1 \
      || echo "brain: initial push to $remote failed (offline/empty host?) — the next merge will push" >&2
  fi
  echo "brain: initialized at $dir (branch: main)"
}

# ── project namespaces + compiled artifacts ──────────────────────────────────

# brain_ensure_ns <repo-name> — create repos/<name>/ with sessions/, handoffs/
# and placeholder compiled artifacts (brief.md + working.md, regenerated by the
# B3 distiller). Commits only when something new was created. Prints ns path.
brain_ensure_ns() {
  local name; name="$(_brain_slugify "${1:?brain_ensure_ns: repo name required}")"
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain_ensure_ns: no brain repo at $d — run 'myai brain init'" >&2; return 1; }
  local ns="$d/repos/$name"
  if [ ! -d "$ns" ]; then
    mkdir -p "$ns/sessions" "$ns/handoffs"
    touch "$ns/sessions/.gitkeep" "$ns/handoffs/.gitkeep"
    printf '# %s — boot brief\n\n_Not compiled yet. The distiller (`brain merge`) fills this (~150 tokens)._\n' "$name" > "$ns/brief.md"
    printf '# %s — working context\n\n_Not compiled yet. The distiller (`brain merge`) fills this (~2k tokens)._\n' "$name" > "$ns/working.md"
    git -C "$d" add "repos/$name"
    git -C "$d" commit -q -m "brain(ns): add repo namespace $name"
  fi
  printf '%s\n' "$ns"
}

# ── append-only atoms ────────────────────────────────────────────────────────

# brain_atom_write <kind> <repo|-> <slug>   (content on stdin)
#   kind ∈ session | handoff | memory. repo '-' (or empty) targets the
#   cross-repo memory/ dir (only valid for kind=memory). Writes ONE immutable
#   file, commits it on the CURRENT branch, prints the repo-relative path.
#   Dedup: an existing <slug>-<sha8> match in the target dir is a no-op.
brain_atom_write() {
  local kind="${1:?brain_atom_write: kind required}" repo="${2:-}" slug="${3:?brain_atom_write: slug required}"
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain_atom_write: no brain repo at $d — run 'myai brain init'" >&2; return 1; }
  slug="$(_brain_slugify "$slug")"

  local subdir
  case "$kind" in
    memory)  subdir="memory" ;;
    session) subdir="sessions" ;;
    handoff) subdir="handoffs" ;;
    *) echo "brain_atom_write: kind must be session|handoff|memory (got '$kind')" >&2; return 2 ;;
  esac

  local reldir
  if [ "$kind" = "memory" ] && { [ -z "$repo" ] || [ "$repo" = "-" ]; }; then
    repo=""
    reldir="memory"
  else
    [ -n "$repo" ] && [ "$repo" != "-" ] || { echo "brain_atom_write: kind '$kind' requires a repo name" >&2; return 2; }
    repo="$(_brain_slugify "$repo")"
    brain_ensure_ns "$repo" >/dev/null || return 1
    reldir="repos/$repo/$subdir"
  fi

  local body; body="$(cat)"
  [ -n "$body" ] || { echo "brain_atom_write: empty content on stdin" >&2; return 2; }
  local sha8; sha8="$(printf '%s' "$body" | _brain_sha8)"

  # Dedup: identical fact already recorded under this slug → no-op.
  local existing
  existing="$(ls "$d/$reldir/" 2>/dev/null | grep -F -- "-$slug-$sha8.md" | head -1 || true)"
  if [ -n "$existing" ]; then
    echo "brain: atom exists — $reldir/$existing (dedup, no-op)"
    printf '%s\n' "$reldir/$existing"
    return 0
  fi

  local ts host rel
  ts="$(_brain_utc)"; host="$(brain_host)"
  rel="$reldir/$ts-$host-$slug-$sha8.md"
  if [ -e "$d/$rel" ]; then
    # Same second + same host + same slug but different content cannot collide
    # (sha8 differs); an existing path here means a hash collision — refuse
    # rather than ever mutate an atom.
    echo "brain_atom_write: refusing to overwrite existing atom $rel" >&2
    return 1
  fi
  # BRAIN B5: optional code↔memory provenance, passed via env (existing callers
  # unaffected): BRAIN_CODE_REPO / BRAIN_CODE_BRANCH / BRAIN_CODE_SHA /
  # BRAIN_CODE_COMMITS (space-separated SHAs). Stamped into the frontmatter AND
  # as Code-* git trailers on the brain commit — what `brain_blame` greps.
  # Node mirror: writeAtom({code}) in runtime/src/core/brain.ts.
  local p_repo="${BRAIN_CODE_REPO:-}" p_branch="${BRAIN_CODE_BRANCH:-}" p_sha="${BRAIN_CODE_SHA:-}" p_commits="${BRAIN_CODE_COMMITS:-}"
  local p_any="$p_repo$p_branch$p_sha$p_commits"
  if [ -n "$p_any" ] && [ -z "$p_repo" ]; then p_repo="$repo"; fi
  {
    printf -- '---\n'
    printf 'kind: %s\n' "$kind"
    printf 'repo: %s\n' "${repo:-—}"
    printf 'slug: %s\n' "$slug"
    printf 'host: %s\n' "$host"
    printf 'written: %s\n' "$ts"
    if [ -n "$p_any" ]; then
      [ -n "$p_repo" ]    && printf 'code-repo: %s\n' "$(_brain_slugify "$p_repo")"
      [ -n "$p_branch" ]  && printf 'code-branch: %s\n' "$p_branch"
      [ -n "$p_sha" ]     && printf 'code-sha: %s\n' "$p_sha"
      [ -n "$p_commits" ] && printf 'code-commits: %s\n' "$p_commits"
    fi
    printf -- '---\n\n'
    printf '%s\n' "$body"
  } > "$d/$rel"
  git -C "$d" add "$rel"
  local msg="brain($kind): ${repo:-memory}/$slug"
  if [ -n "$p_any" ]; then
    msg="$msg
"
    [ -n "$p_repo" ]   && msg="$msg
Code-Repo: $(_brain_slugify "$p_repo")"
    [ -n "$p_branch" ] && msg="$msg
Code-Branch: $p_branch"
    [ -n "$p_sha" ]    && msg="$msg
Code-SHA: $p_sha"
    local c
    for c in $p_commits; do msg="$msg
Code-Commit: $c"; done
  fi
  git -C "$d" commit -q -m "$msg"
  printf '%s\n' "$rel"
}

# ── code↔memory provenance (BRAIN B5) ────────────────────────────────────────

# brain_capture_code <code-repo-dir> — export BRAIN_CODE_REPO/BRANCH/SHA from a
# code checkout, so the next brain_atom_write in this shell stamps provenance.
# Prints what it captured. Not a code repo → clears the vars, returns 1.
brain_capture_code() {
  local cd="${1:?brain_capture_code: code repo dir required}"
  if ! git -C "$cd" rev-parse --git-dir >/dev/null 2>&1; then
    unset BRAIN_CODE_REPO BRAIN_CODE_BRANCH BRAIN_CODE_SHA 2>/dev/null || true
    echo "brain_capture_code: $cd is not a git repo" >&2
    return 1
  fi
  BRAIN_CODE_REPO="$(basename "$(git -C "$cd" rev-parse --show-toplevel)")"
  BRAIN_CODE_BRANCH="$(git -C "$cd" rev-parse --abbrev-ref HEAD)"
  BRAIN_CODE_SHA="$(git -C "$cd" rev-parse HEAD)"
  export BRAIN_CODE_REPO BRAIN_CODE_BRANCH BRAIN_CODE_SHA
  echo "code: $BRAIN_CODE_REPO@$BRAIN_CODE_SHA ($BRAIN_CODE_BRANCH)"
}

# brain_note_code <code-repo-dir> <brain-commit> <atom-path> <code-sha>…
# Back-link code commits to a brain commit with git notes under
# refs/notes/myai-brain — zero code-HISTORY pollution (notes are a separate
# ref; `git log --notes=myai-brain` shows them, nothing else changes).
# Append (never overwrite): one code commit may relate to several brain commits.
brain_note_code() {
  local cd="${1:?brain_note_code: code repo dir required}"
  local bsha="${2:?brain_note_code: brain commit sha required}"
  local atom="${3:?brain_note_code: atom path required}"
  shift 3
  [ $# -gt 0 ] || { echo "brain_note_code: at least one code sha required" >&2; return 2; }
  local c noted=0
  for c in "$@"; do
    git -C "$cd" notes --ref=myai-brain append -m "myai-brain: $bsha $atom" "$c" 2>/dev/null && noted=$((noted+1))
  done
  echo "brain: noted $noted code commit(s) → brain $bsha (refs/notes/myai-brain)"
}

# brain_blame <code-sha | brain-ref> [limit]
# Forward (arg looks like a SHA): which brain commits reference that code
# commit — "what was the agent thinking when it produced X" (+ atom files to
# read). Reverse (arg is a brain ref, e.g. idea/<slug>): every code SHA that
# ref's commits recorded. Reads the Code-* trailers brain_atom_write stamps.
brain_blame() {
  local q="${1:?brain_blame: code sha or brain ref required}" limit="${2:-50}"
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain_blame: no brain repo at $d" >&2; return 1; }
  local sha
  if printf '%s' "$q" | grep -qE '^[0-9a-f]{7,40}$'; then
    # code → brain: candidates via --grep, verified against the trailers.
    local hits=0
    for sha in $(git -C "$d" log --all -n $((limit * 4)) --format='%H' --grep="$q" 2>/dev/null); do
      git -C "$d" show -s --format='%B' "$sha" | grep -qE "^Code-(SHA|Commit): $q" || continue
      hits=$((hits+1)); [ "$hits" -gt "$limit" ] && break
      printf '%s\n' "$(git -C "$d" show -s --format='%h %aI %s' "$sha")"
      git -C "$d" show -s --format='%B' "$sha" | grep -E '^Code-' | sed 's/^/  /'
      git -C "$d" show --format= --name-only "$sha" 2>/dev/null \
        | grep -E '^(memory|repos/[^/]+/(sessions|handoffs))/.*\.md$' | sed 's/^/  atom: /'
    done
    [ "$hits" -gt 0 ] || { echo "brain_blame: no brain commit references code $q"; return 1; }
  else
    # brain → code: list recorded code SHAs for a brain ref.
    git -C "$d" rev-parse --verify --quiet "$q^{commit}" >/dev/null \
      || { echo "brain_blame: unknown ref '$q'" >&2; return 1; }
    local hits=0
    for sha in $(git -C "$d" log -n $((limit * 4)) --format='%H' "$q"); do
      git -C "$d" show -s --format='%B' "$sha" | grep -qE '^Code-' || continue
      hits=$((hits+1)); [ "$hits" -gt "$limit" ] && break
      printf '%s\n' "$(git -C "$d" show -s --format='%h %aI %s' "$sha")"
      git -C "$d" show -s --format='%B' "$sha" | grep -E '^Code-' | sed 's/^/  /'
    done
    [ "$hits" -gt 0 ] || { echo "brain_blame: no code provenance recorded on '$q'"; return 1; }
  fi
  return 0
}

# brain_stamp_code <code-repo-dir> <repo-ns> <slug> [code-sha…]   (content on stdin)
# The runner-facing one-shot (BRAIN B5): capture code provenance, write ONE
# session atom on a runner session branch, merge it to main (auto-distill),
# then git-notes-back-link each produced code commit to the brain commit.
# Prints "atom: <path>" + "brain: <main sha>". Never touches code history.
brain_stamp_code() {
  local cd="${1:?brain_stamp_code: code repo dir required}"
  local ns="${2:?brain_stamp_code: repo namespace required}"
  local slug="${3:?brain_stamp_code: slug required}"
  shift 3
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain_stamp_code: no brain repo at $d — run 'myai brain init'" >&2; return 1; }
  local body; body="$(cat)"
  [ -n "$body" ] || { echo "brain_stamp_code: empty content on stdin" >&2; return 2; }

  brain_capture_code "$cd" >/dev/null || return 1
  BRAIN_CODE_COMMITS="$*"; export BRAIN_CODE_COMMITS
  brain_session_start runner >/dev/null || return 1
  local rel
  rel="$(printf '%s\n' "$body" | brain_atom_write session "$ns" "$slug" | tail -1)" || return 1
  local bsha; bsha="$(git -C "$d" rev-parse HEAD)"
  brain_session_merge >/dev/null || true
  unset BRAIN_CODE_COMMITS BRAIN_CODE_REPO BRAIN_CODE_BRANCH BRAIN_CODE_SHA 2>/dev/null || true
  echo "atom: $rel"
  echo "brain: $bsha"
  # shellcheck disable=SC2086
  [ $# -gt 0 ] && brain_note_code "$cd" "$bsha" "$rel" "$@"
  return 0
}

# ── session / idea branch lifecycle ──────────────────────────────────────────

# brain_session_start [profile] — create (or resume) today's session branch
# for this host+profile: session/<YYYYMMDD>-<host>-<profile>. Prints branch.
brain_session_start() {
  local profile; profile="$(_brain_slugify "${1:-${BRAIN_PROFILE:-cli}}")"
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain_session_start: no brain repo at $d — run 'myai brain init'" >&2; return 1; }
  # Pull-on-boot: catch up main from origin before branching (bounded, non-fatal).
  brain_sync_pull
  local branch="session/$(date -u +%Y%m%d)-$(brain_host)-$profile"
  if git -C "$d" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$d" checkout -q "$branch"
  else
    git -C "$d" checkout -q main
    git -C "$d" checkout -q -b "$branch"
  fi
  printf '%s\n' "$branch"
}

# brain_session_merge [branch] — merge a session (or idea) branch into main
# (--no-ff so the session boundary survives in history) and delete it.
# Append-only atoms make this conflict-free by construction; if a conflict
# somehow occurs (compiled artifacts touched on both sides), abort + report.
brain_session_merge() {
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain_session_merge: no brain repo at $d" >&2; return 1; }
  local branch="${1:-$(git -C "$d" rev-parse --abbrev-ref HEAD)}"
  case "$branch" in
    session/*|idea/*) ;;
    main) echo "brain_session_merge: already on main — nothing to merge" >&2; return 2 ;;
    *) echo "brain_session_merge: refusing to merge non-session branch '$branch'" >&2; return 2 ;;
  esac
  git -C "$d" show-ref --verify --quiet "refs/heads/$branch" \
    || { echo "brain_session_merge: no such branch '$branch'" >&2; return 1; }
  git -C "$d" checkout -q main
  if ! git -C "$d" merge -q --no-ff -m "brain(merge): $branch" "$branch" 2>/dev/null; then
    git -C "$d" merge --abort 2>/dev/null || true
    echo "brain_session_merge: CONFLICT merging $branch into main — left unmerged (atoms are append-only; check compiled artifacts)" >&2
    git -C "$d" checkout -q "$branch"
    return 1
  fi
  # idea/ branches are long-lived parallel thought — keep them after a merge.
  case "$branch" in
    session/*) git -C "$d" branch -q -D "$branch" ;;
  esac
  # Compile-at-write (BRAIN B3): the merge IS the write — regenerate the
  # compiled artifacts on main right here (extractive, zero LLM tokens).
  brain_distill || true
  # Push-on-merge: mirror the new main to origin (bounded, non-fatal).
  brain_sync_push
  echo "brain: merged $branch into main"
}

# ── compile-at-write distiller (BRAIN B3) ────────────────────────────────────
#
# brain_distill [ns …] — regenerate each namespace's compiled artifacts from
# its atoms and commit them to main: brief.md (~150 tok boot brief), working.md
# (~2k tok: latest handoff + recent sessions), rollup.md (one line per atom).
# EXTRACTIVE + deterministic (plain text work, no LLM) so it costs zero
# interactive tokens and runs anywhere. No args → every namespace. Reading the
# result needs NO server — plain files on main (git pull → read files).
# Node mirror: runtime/src/core/distill.ts (same artifact contract).
brain_distill() {
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain_distill: no brain repo at $d" >&2; return 1; }
  [ -z "$(git -C "$d" status --porcelain)" ] \
    || { echo "brain_distill: working tree dirty — refusing" >&2; return 1; }
  local original; original="$(git -C "$d" rev-parse --abbrev-ref HEAD)"
  [ "$original" = "main" ] || git -C "$d" checkout -q main

  local targets nsdir
  targets="$*"
  if [ -z "$targets" ]; then
    for nsdir in "$d"/repos/*/; do
      [ -d "$nsdir" ] && targets="$targets $(basename "$nsdir")"
    done
  fi

  local ns count=0
  for ns in $targets; do
    ns="$(_brain_slugify "$ns")"
    [ -d "$d/repos/$ns" ] || { echo "brain_distill: no namespace repos/$ns" >&2; continue; }
    count=$((count + 1))
    _brain_distill_ns "$ns" "$d" "$d"
  done

  if [ -n "$(git -C "$d" status --porcelain -- repos)" ]; then
    git -C "$d" add repos
    git -C "$d" commit -q -m "brain(distill): compiled brief/working/rollup"
    echo "brain: distilled $count namespace(s) onto main"
  fi
  [ "$original" = "main" ] || git -C "$d" checkout -q "$original"
  return 0
}

# _brain_apply_exclude <exclude-file> — filter stdin (one atom filename per
# line), dropping any line that exact-matches an entry in <exclude-file>. No
# file (or empty file) → passthrough. Used by brain_dream (BRAIN B5) to hide
# superseded atoms from the COMPILED VIEW without ever touching the raw file.
_brain_apply_exclude() {
  local exclude="$1"
  if [ -n "$exclude" ] && [ -s "$exclude" ]; then grep -vFxf "$exclude"; else cat; fi
}

# _brain_distill_ns <ns> <src_dir> <out_dir> [exclude_file]
#
# Render one namespace's brief/working/rollup.md from its atoms under
# <src_dir>/repos/<ns> into <out_dir>/repos/<ns>/. Atom filenames listed (one
# per line) in [exclude_file] are hidden from the compiled view — the raw atom
# file under <src_dir> is never read for writing, only for display text, so it
# is never touched. Shared by:
#   • brain_distill  — out_dir == src_dir, no exclude → today's in-place compile
#   • brain_dream    — out_dir == a scratch dir, exclude == near-dup supersedes
#                       (BRAIN B5 step 8: recompile a candidate view to gate
#                       before the blue-green swap)
_brain_distill_ns() {
  local ns="$1" d="$2" outdir="$3" exclude="${4:-}"
  mkdir -p "$outdir/repos/$ns"
  local sess_all hand_all sess_count hand_count latest
  sess_all="$(ls "$d/repos/$ns/sessions/" 2>/dev/null | grep '\.md$' | _brain_apply_exclude "$exclude")"
  hand_all="$(ls "$d/repos/$ns/handoffs/" 2>/dev/null | grep '\.md$' | _brain_apply_exclude "$exclude")"
  sess_count="$(printf '%s\n' "$sess_all" | grep -c . || true)"
  hand_count="$(printf '%s\n' "$hand_all" | grep -c . || true)"
  latest="$(printf '%s\n' "$hand_all" | sort | tail -1)"
  if [ -n "$latest" ]; then latest="$d/repos/$ns/handoffs/$latest"
  else
    latest="$(printf '%s\n' "$sess_all" | sort | tail -1)"
    [ -n "$latest" ] && latest="$d/repos/$ns/sessions/$latest"
  fi

  # brief.md — ~150-token boot brief: counts line + latest handoff, flattened.
  {
    printf '# %s — boot brief\n\n' "$ns"
    printf '_%s sessions · %s handoffs · distilled from atoms on main._\n\n' "$sess_count" "$hand_count"
    if [ -n "$latest" ] && [ -f "$latest" ]; then
      _brain_strip_fm "$latest" | tr '\n' ' ' | sed 's/  */ /g;s/^ *//;s/ *$//' | cut -c1-560
      printf '\n'
    else
      printf '_No atoms yet — commit session/handoff atoms and merge to fill this._\n'
    fi
  } > "$outdir/repos/$ns/brief.md"

  # working.md — latest handoff verbatim + last 5 sessions, capped ~8000 chars.
  {
    printf '# %s — working context\n\n' "$ns"
    if [ -n "$latest" ] && [ -f "$latest" ]; then
      printf '## Latest handoff\n\n'
      _brain_strip_fm "$latest"
      printf '\n'
    fi
    local recent atom
    recent="$(printf '%s\n' "$sess_all" | sort -r | head -5)"
    if [ -n "$recent" ]; then
      printf '## Recent sessions (newest first)\n\n'
      for atom in $recent; do
        printf '### %s\n\n' "$atom"
        _brain_strip_fm "$d/repos/$ns/sessions/$atom" | head -20
        printf '\n'
      done
    fi
  } | head -c 8000 > "$outdir/repos/$ns/working.md"

  # rollup.md — one line per (non-excluded) atom (index of the namespace's history).
  {
    printf '# %s — rollup\n\n' "$ns"
    local kind names atom first
    for kind in sessions handoffs; do
      if [ "$kind" = "sessions" ]; then names="$sess_all"; else names="$hand_all"; fi
      names="$(printf '%s\n' "$names" | sort -r)"
      for atom in $names; do
        [ -n "$atom" ] || continue
        first="$(_brain_strip_fm "$d/repos/$ns/$kind/$atom" | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-120)"
        printf -- '- %s %s — %s\n' "$kind" "$atom" "$first"
      done
    done
  } > "$outdir/repos/$ns/rollup.md"
}

# Strip the leading `---` frontmatter block from an atom file (prints the body).
_brain_strip_fm() {
  awk 'NR==1 && $0=="---" {fm=1; next} fm==1 {if ($0=="---") fm=2; next} {print}' "$1"
}

# brain_idea <slug> — create (or resume) a long-lived idea branch off main.
brain_idea() {
  local slug; slug="$(_brain_slugify "${1:?brain_idea: slug required}")"
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain_idea: no brain repo at $d — run 'myai brain init'" >&2; return 1; }
  local branch="idea/$slug"
  if git -C "$d" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$d" checkout -q "$branch"
  else
    git -C "$d" checkout -q main
    git -C "$d" checkout -q -b "$branch"
  fi
  printf '%s\n' "$branch"
}

# ── B8 git verbs: stash / pop / checkout / diff / revert ─────────────────────
#
# The `myai brain` git-muscle-memory surface (plan/jam/brain-layer.md keywords).
# Node mirror: the B2 ops in runtime/src/core/brain.ts (brainStash/brainPop/
# brainCheckout/brainDiff/brainRevert) — both sides honor the same contract:
# never force-push, never rewrite history, never edit an existing atom.

_brain_require_clean() {
  local d; d="$(brain_dir)"
  [ -z "$(git -C "$d" status --porcelain)" ] \
    || { echo "brain: working tree is dirty — brain ops always commit; refusing to proceed" >&2; return 1; }
}

# brain_stash <slug> [repo]   (content on stdin)
# Freeze a context payload so ANY later session can resume it. NOT `git stash`
# (local, ref-based, invisible elsewhere): a FILE under stash/ committed
# straight to main, so any session — different branch, host, agent — sees it
# after a plain pull and can pop it. Dedup: identical payload already frozen
# is a no-op. Prints the stash path.
brain_stash() {
  local slug="${1:?brain_stash: slug required}" repo="${2:-}"
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain_stash: no brain repo at $d — run 'myai brain init'" >&2; return 1; }
  slug="$(_brain_slugify "$slug")"
  [ -n "$slug" ] || { echo "brain_stash: slug required" >&2; return 2; }
  local body; body="$(cat)"
  [ -n "$body" ] || { echo "brain_stash: empty content on stdin" >&2; return 2; }
  # Content hash in the filename (same contract as atoms): same-second stashes
  # with different payloads can never collide on a path.
  local sha8; sha8="$(printf '%s' "$body" | _brain_sha8)"
  # Dedup: identical payload already frozen under this slug (any timestamp/host)
  # → no-op, same as atoms.
  local existing
  existing="$(git -C "$d" ls-tree --name-only main stash/ 2>/dev/null | grep -F -- "-$slug-$sha8.md" | head -1 || true)"
  if [ -n "$existing" ]; then
    echo "brain: stash exists — $existing (dedup, no-op)" >&2
    printf '%s\n' "$existing"
    return 0
  fi
  local rel="stash/$(_brain_utc)-$(brain_host)-$slug-$sha8.md"
  _brain_require_clean || return 1
  local from; from="$(git -C "$d" rev-parse --abbrev-ref HEAD)"
  [ "$from" = "main" ] || git -C "$d" checkout -q main
  mkdir -p "$d/stash"
  {
    printf -- '---\n'
    printf 'slug: %s\n' "$slug"
    printf 'repo: %s\n' "${repo:+$(_brain_slugify "$repo")}"
    printf 'from: %s\n' "$from"
    printf 'host: %s\n' "$(brain_host)"
    printf 'written: %s\n' "$(_brain_utc)"
    printf -- '---\n\n'
    printf '%s\n' "$body"
  } > "$d/$rel"
  git -C "$d" add "$rel"
  git -C "$d" commit -q -m "brain(stash): $slug"
  [ "$from" = "main" ] || git -C "$d" checkout -q "$from"
  # Stash pushes IMMEDIATELY — its whole point is cross-device resume.
  brain_sync_push
  echo "brain: stashed '$slug' on main — pop from any session/device" >&2
  printf '%s\n' "$rel"
}

# brain_stash_list — stash paths visible on main, newest first (by stash-commit
# order — filenames only have second precision, so they can't order
# same-second stashes). Empty output (rc 0) when there are none.
brain_stash_list() {
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || return 0
  git -C "$d" rev-parse --verify --quiet "main:stash" >/dev/null 2>&1 || return 0
  local alive added p
  alive="$(git -C "$d" ls-tree --name-only main stash/ 2>/dev/null | grep '\.md$' || true)"
  added="$(git -C "$d" log main --diff-filter=A --name-only --format= -- stash/ 2>/dev/null | grep '\.md$' || true)"
  for p in $added; do
    printf '%s\n' "$alive" | grep -qxF "$p" && printf '%s\n' "$p"
  done
  return 0
}

# brain_pop [slug] — pop the newest stash (or the newest matching slug): print
# the frozen file (frontmatter + payload) to stdout and remove the entry from
# main with a normal commit. Nothing is ever rewritten.
brain_pop() {
  local wanted="${1:-}"
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain_pop: no brain repo at $d — run 'myai brain init'" >&2; return 1; }
  [ -n "$wanted" ] && wanted="$(_brain_slugify "$wanted")"
  local p s entry=""
  for p in $(brain_stash_list); do
    if [ -z "$wanted" ]; then entry="$p"; break; fi
    # Slug comes from frontmatter, not the filename — hostnames may contain
    # dashes, which makes filename parsing ambiguous.
    s="$(git -C "$d" show "main:$p" 2>/dev/null | sed -n 's/^slug: //p' | head -1)"
    [ "$s" = "$wanted" ] && { entry="$p"; break; }
  done
  [ -n "$entry" ] || { echo "brain_pop: no stash${wanted:+ matching '$wanted'} to pop" >&2; return 1; }
  local raw; raw="$(git -C "$d" show "main:$entry")"
  _brain_require_clean || return 1
  local from; from="$(git -C "$d" rev-parse --abbrev-ref HEAD)"
  [ "$from" = "main" ] || git -C "$d" checkout -q main
  git -C "$d" rm -q "$entry"
  git -C "$d" commit -q -m "brain(pop): ${entry#stash/}"
  [ "$from" = "main" ] || git -C "$d" checkout -q "$from"
  echo "brain: popped $entry" >&2
  printf '%s\n' "$raw"
}

# brain_checkout <ref> — check out main or an existing session/idea branch.
# Only the managed families are checkoutable; requires a clean tree.
brain_checkout() {
  local ref="${1:?brain_checkout: ref required (main | session/* | idea/*)}"
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain_checkout: no brain repo at $d — run 'myai brain init'" >&2; return 1; }
  case "$ref" in
    main|session/?*|idea/?*) ;;
    *) echo "brain_checkout: refusing checkout of '$ref' — only main, session/* or idea/*" >&2; return 2 ;;
  esac
  git -C "$d" show-ref --verify --quiet "refs/heads/$ref" \
    || { echo "brain_checkout: no such branch '$ref'" >&2; return 1; }
  _brain_require_clean || return 1
  git -C "$d" checkout -q "$ref"
  printf '%s\n' "$ref"
}

# brain_diff [from] [to] — what <to> has that <from> doesn't (default
# main..HEAD: "what has this session added that main doesn't have yet").
brain_diff() {
  local from="${1:-main}" to="${2:-HEAD}"
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain_diff: no brain repo at $d — run 'myai brain init'" >&2; return 1; }
  local ref
  for ref in "$from" "$to"; do
    git -C "$d" rev-parse --verify --quiet "$ref^{commit}" >/dev/null \
      || { echo "brain_diff: unknown ref '$ref'" >&2; return 1; }
  done
  echo "brain diff: $from..$to"
  git -C "$d" diff --name-status "$from..$to"
  git -C "$d" diff --shortstat "$from..$to"
  return 0
}

# brain_revert <sha> — undo a commit with an inverse commit (history is never
# rewritten — atoms stay append-only; the revert itself is a new commit).
# Merge commits revert against their first parent. Conflict → abort, rc 1.
brain_revert() {
  local sha="${1:?brain_revert: commit sha required}"
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain_revert: no brain repo at $d — run 'myai brain init'" >&2; return 1; }
  git -C "$d" rev-parse --verify --quiet "$sha^{commit}" >/dev/null \
    || { echo "brain_revert: unknown commit '$sha'" >&2; return 1; }
  _brain_require_clean || return 1
  local full parents ok=0
  full="$(git -C "$d" rev-parse "$sha^{commit}")"
  parents="$(git -C "$d" rev-list --parents -n1 "$full" | wc -w | tr -d ' ')"
  if [ "$parents" -gt 2 ]; then
    git -C "$d" revert --no-edit -m 1 "$full" >/dev/null 2>&1 && ok=1
  else
    git -C "$d" revert --no-edit "$full" >/dev/null 2>&1 && ok=1
  fi
  if [ "$ok" != "1" ]; then
    git -C "$d" revert --abort 2>/dev/null || true
    echo "brain_revert: CONFLICT reverting $sha — aborted, brain unchanged" >&2
    return 1
  fi
  echo "brain: reverted $full → $(git -C "$d" rev-parse HEAD) (inverse commit)"
}

# ── gc: compact the store (dedup / prune / repack) ───────────────────────────
#
# The brain grows unbounded: two-host merges land byte-identical atoms under
# different <ts>-<host>- prefixes, `brain init` scaffolds namespaces that never
# receive an atom, stashes get frozen and never popped, and git's loose-object
# count climbs. `brain_gc` bounds that growth WITHOUT ever rewriting history or
# mutating an atom's content — it only removes provably-redundant files with
# normal (revertable) commits, then repacks:
#   • atom dedup     — files sharing (dir, slug, content-sha8) collapse to the
#                      earliest; the survivor is byte-identical so recall is
#                      unchanged (same contract brain_atom_write enforces on a
#                      single branch, applied across merged histories)
#   • orphan prune   — repos/<ns>/ namespaces with zero session+handoff atoms
#                      (scaffolding only — brief/working are uncompiled stubs)
#   • stash prune    — stashes frozen more than <stash-age> days ago (default
#                      30) and never popped — abandoned resume points
#   • repack         — `git gc --prune=now` folds loose objects + drops the now
#                      -unreachable blobs, bounding .git growth
# --dry-run prints the plan and reclaims nothing. Node mirror: brainGc() in
# runtime/src/core/brain.ts. Round-trip safe: everything it removes is either a
# byte-identical duplicate or an empty/expired pointer.
brain_gc() {
  local dry=0 stash_age=30
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run|-n) dry=1 ;;
      --stash-age)  stash_age="${2:?--stash-age needs a value}"; shift ;;
      --stash-age=*) stash_age="${1#*=}" ;;
      *) echo "brain_gc: unknown option '$1'" >&2; return 2 ;;
    esac
    shift
  done
  case "$stash_age" in ''|*[!0-9]*) echo "brain_gc: --stash-age must be a whole number of days" >&2; return 2 ;; esac
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain_gc: no brain repo at $d — run 'myai brain init'" >&2; return 1; }
  _brain_require_clean || return 1

  local size_before; size_before="$(du -sk "$d/.git" 2>/dev/null | cut -f1)"; size_before="${size_before:-0}"

  # ── plan: atom dedup — group live atoms by (dir, slug, content-sha8) ─────────
  # The filename's trailing -<sha8>.md IS sha8(body) and the frontmatter carries
  # the slug, so the key needs no fragile host/slug boundary parsing. Sorting
  # filenames ascending keeps the earliest (ts prefix sorts chronologically).
  local plan; plan="$(mktemp -t brain-gc.XXXXXX)"
  local remove_atoms; remove_atoms="$(mktemp -t brain-gc.XXXXXX)"
  local reldir f slug sha key prevkey=""
  for reldir in memory $(cd "$d" && ls -d repos/*/sessions repos/*/handoffs 2>/dev/null); do
    [ -d "$d/$reldir" ] || continue
    for f in $(cd "$d/$reldir" && ls *.md 2>/dev/null | grep -v '^\.gitkeep$' | sort); do
      slug="$(sed -n 's/^slug: //p' "$d/$reldir/$f" | head -1)"
      sha="$(printf '%s\n' "$f" | sed -E 's/.*-([0-9a-f]{8})\.md$/\1/')"
      printf '%s\t%s\n' "$reldir|$slug|$sha" "$reldir/$f" >> "$plan"
    done
  done
  # Emit the 2nd+ file of each key as a removal (LC_ALL=C for a stable sort).
  LC_ALL=C sort "$plan" | while IFS="$(printf '\t')" read -r key path; do
    if [ "$key" = "$prevkey" ]; then printf '%s\n' "$path" >> "$remove_atoms"; fi
    prevkey="$key"
  done
  local dup_count; dup_count="$(wc -l < "$remove_atoms" | tr -d ' ')"

  # ── plan: orphan namespaces — repos/<ns>/ with zero session+handoff atoms ────
  local remove_ns; remove_ns="$(mktemp -t brain-gc.XXXXXX)"
  local ns nspath atoms
  for nspath in $(cd "$d" && ls -d repos/*/ 2>/dev/null); do
    ns="${nspath%/}"
    atoms="$(find "$d/$ns/sessions" "$d/$ns/handoffs" -name '*.md' ! -name '.gitkeep' 2>/dev/null | wc -l | tr -d ' ')"
    [ "$atoms" = "0" ] && printf '%s\n' "$ns" >> "$remove_ns"
  done
  local ns_count; ns_count="$(wc -l < "$remove_ns" | tr -d ' ')"

  # ── plan: abandoned stashes — frozen > stash_age days ago, never popped ──────
  local remove_stash; remove_stash="$(mktemp -t brain-gc.XXXXXX)"
  local now cutoff s ct
  now="$(date -u +%s)"; cutoff=$(( now - stash_age * 86400 ))
  for s in $(brain_stash_list); do
    ct="$(git -C "$d" log -1 --format=%ct -- "$s" 2>/dev/null)"
    [ -n "$ct" ] && [ "$ct" -lt "$cutoff" ] && printf '%s\n' "$s" >> "$remove_stash"
  done
  local stash_count; stash_count="$(wc -l < "$remove_stash" | tr -d ' ')"

  echo "brain gc: $d"
  echo "  duplicate atoms:     $dup_count"
  echo "  orphan namespaces:   $ns_count"
  echo "  abandoned stashes:   $stash_count (> ${stash_age}d)"

  if [ "$dry" = "1" ]; then
    echo "  mode:                DRY RUN (nothing removed, store untouched)"
    [ "$dup_count" != "0" ]   && { echo "  would dedup:";   sed 's/^/    - /' "$remove_atoms"; }
    [ "$ns_count" != "0" ]    && { echo "  would prune ns:"; sed 's/^/    - /' "$remove_ns"; }
    [ "$stash_count" != "0" ] && { echo "  would prune stash:"; sed 's/^/    - /' "$remove_stash"; }
    rm -f "$plan" "$remove_atoms" "$remove_ns" "$remove_stash"
    return 0
  fi

  # ── apply: remove on main with normal (revertable) commits, then repack ──────
  local from; from="$(git -C "$d" rev-parse --abbrev-ref HEAD)"
  [ "$from" = "main" ] || git -C "$d" checkout -q main
  local removed=0
  if [ "$dup_count" != "0" ] || [ "$ns_count" != "0" ] || [ "$stash_count" != "0" ]; then
    while IFS= read -r path; do [ -n "$path" ] && git -C "$d" rm -q -- "$path" && removed=1; done < "$remove_atoms"
    while IFS= read -r ns;   do [ -n "$ns" ]   && git -C "$d" rm -q -r -- "$ns" && removed=1; done < "$remove_ns"
    while IFS= read -r s;    do [ -n "$s" ]    && git -C "$d" rm -q -- "$s"  && removed=1; done < "$remove_stash"
    if [ "$removed" = "1" ]; then
      git -C "$d" commit -q -m "brain(gc): dedup $dup_count atoms · prune $ns_count ns · $stash_count stash"
    fi
  fi
  # Repack even when nothing was removed — loose objects still accrue from every
  # atom commit; --prune=now drops the blobs the removals just made unreachable.
  git -C "$d" gc --prune=now --quiet 2>/dev/null || git -C "$d" gc --quiet 2>/dev/null || true
  [ "$from" = "main" ] || git -C "$d" checkout -q "$from"
  brain_sync_push

  local size_after; size_after="$(du -sk "$d/.git" 2>/dev/null | cut -f1)"; size_after="${size_after:-0}"
  local reclaimed=$(( size_before - size_after )); [ "$reclaimed" -lt 0 ] && reclaimed=0
  echo "  reclaimed:           ${reclaimed} KB (.git ${size_before}K → ${size_after}K)"
  rm -f "$plan" "$remove_atoms" "$remove_ns" "$remove_stash"
  return 0
}

# ── dream: idle consolidation job (BRAIN B5) ─────────────────────────────────
#
# 10-step blue-green consolidation designed for the idle runner cadence,
# replacing trim_handoff.py's keep-last-N stopgap with supersession-based
# pruning of the COMPILED VIEW (plan/BRAIN_BUILD_PLAN.md B-5). Raw atoms are
# NEVER deleted or edited by this job — only brief/working/rollup.md (the
# distilled view over them) change, and only via a single revertable commit:
#   1. snapshot       — record main's current SHA (the rollback point; git IS
#                        the version store, so no separate snapshot copy)
#   2. normalize/hash  — atoms already carry a content-hash in their filename
#                        (brain_atom_write's contract) — nothing to redo
#   3. dedup           — exact-hash duplicates are brain_gc's job (unchanged);
#                        brain_dream adds NEAR-dup detection: bounded
#                        shingle/Jaccard similarity per (ns, kind) atom group
#                        — a MinHash/embedding-cluster stand-in until B-4's
#                        hybrid retriever ships
#   4. supersedes      — near-dup pairs at/over --sim-threshold are recorded
#                        as an append-only ledger, repos/<ns>/supersedes.jsonl
#   5. preserve raw    — STRUCTURAL: this function never `git rm`s a session/
#                        handoff/memory atom file — only the compiled view
#   6. re-embed        — hook: $MYAI_BRAIN_EMBED_CMD (skipped + logged when
#                        unset — B-4 hasn't shipped an embedding backend yet)
#   7. rebuild index   — hook: $MYAI_BRAIN_INDEX_CMD (skipped + logged, ditto)
#   8. recompile       — brief/working/rollup rebuilt into a scratch candidate
#                        via _brain_distill_ns with superseded atoms hidden
#   9. replay/promote  — per-namespace sanity gate: candidate must be
#                        non-empty and its rollup must not have shrunk past
#                        --min-keep-ratio vs the live rollup. A namespace that
#                        fails the gate keeps its current compiled view —
#                        never blocks other namespaces from promoting
#   10. blue-green     — namespaces that pass swap into one commit; rollback
#                        is the existing `myai brain revert <sha>` (git IS the
#                        blue/green store — no bespoke version directory)
# --dry-run prints the full plan (edges found, per-ns gate result) and writes
# nothing. Node mirror: not yet ported (tracked in plan/BRAIN_BUILD_PLAN.md B-5
# — bash is the runner-facing surface; brain_gc's TS mirror is unused by any
# caller today, so this ships bash-first rather than duplicating unused code).
brain_dream() {
  local dry=0 sim_threshold=85 min_keep_ratio=80
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run|-n) dry=1 ;;
      --sim-threshold)  sim_threshold="${2:?--sim-threshold needs a value}"; shift ;;
      --sim-threshold=*) sim_threshold="${1#*=}" ;;
      --min-keep-ratio)  min_keep_ratio="${2:?--min-keep-ratio needs a value}"; shift ;;
      --min-keep-ratio=*) min_keep_ratio="${1#*=}" ;;
      *) echo "brain_dream: unknown option '$1'" >&2; return 2 ;;
    esac
    shift
  done
  case "$sim_threshold" in ''|*[!0-9]*) echo "brain_dream: --sim-threshold must be a whole 0-100 number" >&2; return 2 ;; esac
  case "$min_keep_ratio" in ''|*[!0-9]*) echo "brain_dream: --min-keep-ratio must be a whole 0-100 number" >&2; return 2 ;; esac

  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain_dream: no brain repo at $d — run 'myai brain init'" >&2; return 1; }
  _brain_require_clean || return 1

  local from; from="$(git -C "$d" rev-parse --abbrev-ref HEAD)"
  [ "$from" = "main" ] || git -C "$d" checkout -q main
  local snapshot; snapshot="$(git -C "$d" rev-parse main)"   # step 1

  local scratch; scratch="$(mktemp -d -t brain-dream.XXXXXX)"
  local edges_json="$scratch/supersedes.jsonl"
  : > "$edges_json"

  echo "brain dream: $d (snapshot $snapshot)"
  [ -n "${MYAI_BRAIN_EMBED_CMD:-}" ] || echo "  step 6 re-embed:    skip (no MYAI_BRAIN_EMBED_CMD configured)"
  [ -n "${MYAI_BRAIN_INDEX_CMD:-}" ] || echo "  step 7 rebuild idx: skip (no MYAI_BRAIN_INDEX_CMD configured)"

  local ns nsdir kind adir edge_total=0 promoted=0 held=0
  for nsdir in "$d"/repos/*/; do
    [ -d "$nsdir" ] || continue
    ns="$(basename "$nsdir")"
    local ns_excl="$scratch/$ns.excl"
    : > "$ns_excl"

    for kind in sessions handoffs; do
      adir="$d/repos/$ns/$kind"
      [ -d "$adir" ] || continue
      local older newer pct
      while IFS='|' read -r older newer pct; do
        [ -n "$older" ] || continue
        printf '{"ns":"%s","kind":"%s","older":"%s","newer":"%s","similarity_pct":%s}\n' \
          "$ns" "$kind" "$older" "$newer" "$pct" >> "$edges_json"
        printf '%s\n' "$older" >> "$ns_excl"
        edge_total=$((edge_total + 1))
      done < <(_brain_dream_near_dups "$adir" "$sim_threshold")
    done

    # step 8: recompile candidate view — reads $d, never writes to it
    _brain_distill_ns "$ns" "$d" "$scratch/candidate" "$ns_excl"

    # step 9: sanity gate
    local live_rollup="$d/repos/$ns/rollup.md" cand_rollup="$scratch/candidate/repos/$ns/rollup.md"
    local live_lines cand_lines gate="pass"
    # grep -c exits 1 on zero matches (not an error — a namespace can be
    # legitimately empty), so check existence separately rather than
    # chaining with && (which would fall through to the || branch and
    # double-print "0").
    live_lines=0; [ -f "$live_rollup" ] && live_lines="$(grep -c '^- ' "$live_rollup")"
    cand_lines=0; [ -f "$cand_rollup" ] && cand_lines="$(grep -c '^- ' "$cand_rollup")"
    if [ ! -s "$scratch/candidate/repos/$ns/brief.md" ] || [ ! -s "$cand_rollup" ]; then
      gate="fail-empty"
    elif [ "$live_lines" -gt 0 ]; then
      local keep_pct=$(( cand_lines * 100 / live_lines ))
      [ "$keep_pct" -lt "$min_keep_ratio" ] && gate="fail-shrink(${keep_pct}%)"
    fi

    local excl_n=0; [ -s "$ns_excl" ] && excl_n="$(grep -c . "$ns_excl")"
    if [ "$gate" = "pass" ]; then
      echo "  $ns: $excl_n superseded → candidate promoted ($cand_lines/$live_lines atoms in rollup)"
      promoted=$((promoted + 1))
      if [ "$dry" != "1" ]; then
        cp "$scratch/candidate/repos/$ns/brief.md" "$d/repos/$ns/brief.md"
        cp "$scratch/candidate/repos/$ns/working.md" "$d/repos/$ns/working.md"
        cp "$scratch/candidate/repos/$ns/rollup.md" "$d/repos/$ns/rollup.md"
        # step 4: persist THIS namespace's supersedes edges only when its
        # candidate view actually went live — a held ns keeps its old view
        # unchanged, so recording edges for it would describe a swap that
        # never happened (ledger drift). A held ns makes zero store changes.
        # Guard with grep -q first — a bare `>>` creates an empty file even
        # when grep matches nothing, which would commit a spurious no-op
        # ledger file on every dry idle cycle.
        if grep -qF "\"ns\":\"$ns\"" "$edges_json" 2>/dev/null; then
          grep -F "\"ns\":\"$ns\"" "$edges_json" >> "$d/repos/$ns/supersedes.jsonl"
        fi
      fi
    else
      echo "  $ns: gate $gate — keeping current compiled view (old version stays live)"
      held=$((held + 1))
    fi
  done

  echo "  near-dup edges:      $edge_total (>= ${sim_threshold}% similarity)"
  echo "  namespaces promoted: $promoted"
  echo "  namespaces held:     $held"

  if [ "$dry" = "1" ]; then
    echo "  mode: DRY RUN (nothing written, store untouched)"
    [ "$edge_total" != "0" ] && { echo "  supersedes plan:"; sed 's/^/    /' "$edges_json"; }
    rm -rf "$scratch"
    [ "$from" = "main" ] || git -C "$d" checkout -q "$from"
    return 0
  fi

  # step 10: blue-green swap — one commit; old version stays reachable/revertable
  if [ -n "$(git -C "$d" status --porcelain -- repos)" ]; then
    git -C "$d" add repos
    git -C "$d" commit -q -m "brain(dream): consolidate $promoted ns · $edge_total supersedes edge(s) · $held held"
    echo "  committed: $(git -C "$d" rev-parse --short HEAD) (rollback: myai brain revert $(git -C "$d" rev-parse --short HEAD))"
  else
    echo "  no changes to commit"
  fi

  rm -rf "$scratch"
  [ "$from" = "main" ] || git -C "$d" checkout -q "$from"
  brain_sync_push
  return 0
}

# _brain_dream_shingles <atom_file> — sorted, unique 4-word shingle set on
# stdout (frontmatter stripped, case-folded, whitespace-collapsed). The
# Jaccard similarity of two atoms' shingle sets approximates MinHash/SimHash
# near-dup detection without an external dependency.
_brain_dream_shingles() {
  _brain_strip_fm "$1" | tr '[:upper:]' '[:lower:]' | tr -s '[:space:]' '\n' | grep -v '^$' | awk '
    { w[NR] = $0 }
    END {
      n = NR
      if (n < 4) {
        for (i = 1; i <= n; i++) print w[i]
      } else {
        for (i = 1; i <= n - 3; i++) print w[i] " " w[i+1] " " w[i+2] " " w[i+3]
      }
    }' | sort -u
}

# _brain_dream_near_dups <dir> <threshold_pct> — prints "older|newer|simPct"
# for every pair of atoms in <dir> whose shingle-set Jaccard similarity is >=
# <threshold_pct>. "older" sorts first (atom filenames are timestamp-prefixed,
# so ascending sort == chronological order) — the direction supersedes edges
# point in (older superseded by newer). Bounded: >200 live atoms in one dir
# skips the O(n²) scan (logged) — B-4's embedding clusters replace this at scale.
_brain_dream_near_dups() {
  local dir="$1" threshold="$2"
  local list; list="$(mktemp -t brain-dream-list.XXXXXX)"
  ls "$dir" 2>/dev/null | grep '\.md$' | sort > "$list"
  local n; n="$(wc -l < "$list" | tr -d ' ')"
  if [ "$n" -le 1 ]; then rm -f "$list"; return 0; fi
  if [ "$n" -gt 200 ]; then
    echo "brain_dream: skip near-dup scan in $dir ($n atoms > 200 cap)" >&2
    rm -f "$list"
    return 0
  fi

  local tmp; tmp="$(mktemp -d -t brain-dream-sh.XXXXXX)"
  local i=0 f
  : > "$tmp/names"
  while IFS= read -r f; do
    i=$((i + 1))
    printf '%s\n' "$f" >> "$tmp/names"
    _brain_dream_shingles "$dir/$f" > "$tmp/$i.shingles"
  done < "$list"
  rm -f "$list"

  local a b fa fb inter uni pct
  a=1
  while [ "$a" -lt "$n" ]; do
    fa="$(sed -n "${a}p" "$tmp/names")"
    b=$((a + 1))
    while [ "$b" -le "$n" ]; do
      fb="$(sed -n "${b}p" "$tmp/names")"
      inter="$(comm -12 "$tmp/$a.shingles" "$tmp/$b.shingles" | wc -l | tr -d ' ')"
      uni="$(sort -u "$tmp/$a.shingles" "$tmp/$b.shingles" | wc -l | tr -d ' ')"
      if [ "$uni" -gt 0 ]; then
        pct=$(( inter * 100 / uni ))
        [ "$pct" -ge "$threshold" ] && printf '%s|%s|%s\n' "$fa" "$fb" "$pct"
      fi
      b=$((b + 1))
    done
    a=$((a + 1))
  done
  rm -rf "$tmp"
}

# ── health score (composite index) ───────────────────────────────────────────
#
# Bash twin of runtime/src/core/brain-health.ts — keep the two in sync (same
# dual-implementation contract as the rest of this file vs brain.ts; twin test
# lives at scripts/tests/test_brain_health.sh). Rolls up ONE 0-100 score from:
#   freshness      days since the last brain commit (decays to 0 by 21d)
#   coverage       namespaces with atoms but brief/working still uncompiled
#   contradictions divergent-brain merge/reconcile events in the last 30 days
#   recall         recall_session eval harness's tracked hit-rate baseline,
#                  when runtime/src/eval/recall-baseline.json exists (this repo
#                  only — managed projects that vendor scripts/ without the
#                  runtime/ tree simply skip that term)
#
# Trend: every call appends a snapshot to $MYAI_HOME/brain-health-history.jsonl
# (throttled to once per hour via the file's own mtime — shared with the Node
# `computeBrainHealth` writer, so either surface can record without double-
# counting). `myai brain status` and the gateway's brain_health MCP tool both
# read/write this same file.

brain_health_history_path() { printf '%s/brain-health-history.jsonl\n' "$(brain_home)"; }

_brain_health_recall_baseline_path() {
  local self_dir
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s/../../runtime/src/eval/recall-baseline.json\n' "$self_dir"
}

_brain_health_file_mtime() {
  # Portable mtime (epoch seconds) — GNU stat vs BSD/macOS stat.
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

# Compute the composite score. Prints one tab-separated line:
#   score  grade  freshnessDays  coverageGaps  namespaceTotal  contradictions  recallPct(or n/a)
# Never writes anything — pure read. brain_health (below) is the CLI-facing wrapper.
brain_health_compute() {
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || return 1

  local last_epoch now_epoch
  now_epoch="$(date +%s)"
  last_epoch="$(git -C "$d" log -1 --format=%ct 2>/dev/null || echo 0)"

  local reposDir="$d/repos" ns_total=0 gaps=0
  if [ -d "$reposDir" ]; then
    local ns atoms
    for ns in "$reposDir"/*/; do
      [ -d "$ns" ] || continue
      ns_total=$((ns_total + 1))
      atoms=$(( $(find "$ns/sessions" -name '*.md' 2>/dev/null | wc -l) + $(find "$ns/handoffs" -name '*.md' 2>/dev/null | wc -l) ))
      [ "$atoms" -eq 0 ] && continue
      if [ ! -f "$ns/brief.md" ] || [ ! -f "$ns/working.md" ] \
        || grep -q 'Not compiled yet\.' "$ns/brief.md" 2>/dev/null \
        || grep -q 'Not compiled yet\.' "$ns/working.md" 2>/dev/null; then
        gaps=$((gaps + 1))
      fi
    done
  fi

  local contradictions
  contradictions="$(git -C "$d" log main --merges --since="30 days ago" --format=%H 2>/dev/null | grep -c .)"

  local recall="null" baseline_path
  baseline_path="$(_brain_health_recall_baseline_path)"
  if [ -f "$baseline_path" ]; then
    recall="$(sed -n 's/.*"hitRate": *\([0-9.][0-9.]*\).*/\1/p' "$baseline_path" | head -1)"
    [ -z "$recall" ] && recall="null"
  fi

  awk -v last="$last_epoch" -v now="$now_epoch" -v gaps="$gaps" -v total="$ns_total" \
      -v contra="$contradictions" -v recall="$recall" '
    function clamp(n) { if (n < 0) return 0; if (n > 100) return 100; return n }
    BEGIN {
      if (last > 0) { freshDays = (now - last) / 86400; fresh = clamp(100 - (freshDays/21)*100) }
      else { freshDays = -1; fresh = 0 }
      cov = (total == 0) ? 100 : clamp(100 - (gaps/total)*100)
      con = clamp(100 - contra*10)
      haveRecall = (recall != "null" && recall != "")
      w = 0.3 + 0.3 + 0.2
      sum = fresh*0.3 + cov*0.3 + con*0.2
      if (haveRecall) { rec = clamp(recall*100); sum += rec*0.2; w += 0.2 }
      score = int(sum/w + 0.5)
      grade = (score>=85)?"excellent":(score>=70)?"good":(score>=50)?"fair":"poor"
      recallOut = haveRecall ? sprintf("%.0f", rec) : "n/a"
      freshOut = (freshDays >= 0) ? sprintf("%.1f", freshDays) : "n/a"
      printf("%d\t%s\t%s\t%d\t%d\t%d\t%s\n", score, grade, freshOut, gaps, total, contra, recallOut)
    }
  '
}

# Append a trend snapshot for the score/grade computed above (throttled to
# once/hour via the history file's mtime). Never fails brain_status over it.
brain_health_record() {
  local score="$1" grade="$2"
  local hist; hist="$(brain_health_history_path)"
  if [ -f "$hist" ]; then
    local age; age=$(( $(date +%s) - $(_brain_health_file_mtime "$hist") ))
    [ "$age" -lt 3600 ] && return 0
  fi
  mkdir -p "$(brain_home)" 2>/dev/null
  local at; at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"at":"%s","score":%s,"grade":"%s"}\n' "$at" "$score" "$grade" >> "$hist"
  # Cap at the most recent 180 snapshots.
  if [ "$(wc -l < "$hist" | tr -d ' ')" -gt 180 ]; then
    tail -n 180 "$hist" > "${hist}.tmp" && mv "${hist}.tmp" "$hist"
  fi
  return 0
}

# CLI-facing: compute, record (best-effort), and print a human-readable line.
brain_health() {
  local row; row="$(brain_health_compute)" || { echo "brain: NOT INITIALIZED — no health score"; return 1; }
  local score grade fresh gaps total contra recall
  IFS="$(printf '\t')" read -r score grade fresh gaps total contra recall <<EOF
$row
EOF
  brain_health_record "$score" "$grade" 2>/dev/null || true
  local freshStr recallStr
  [ "$fresh" = "n/a" ] && freshStr="n/a" || freshStr="${fresh}d"
  [ "$recall" = "n/a" ] && recallStr="n/a" || recallStr="${recall}%"
  echo "  health:     $score/100 ($grade) — freshness ${freshStr} · coverage ${gaps}/${total} gaps · contradictions ${contra}/30d · recall ${recallStr}"
}

# Standalone `myai brain health` — the score line plus the recent trend (last
# 10 recorded snapshots, oldest first). Same underlying score as brain_status's
# inline line; this is the detail view.
brain_health_report() {
  local d; d="$(brain_dir)"
  brain_is_repo "$d" || { echo "brain: NOT INITIALIZED (would live at $d) — run 'myai brain init'"; return 1; }
  echo "brain health: $d"
  brain_health
  local hist; hist="$(brain_health_history_path)"
  if [ -f "$hist" ]; then
    echo "  trend (last 10):"
    tail -n 10 "$hist" | sed -n 's/.*"at":"\([^"]*\)".*"score":\([0-9]*\).*"grade":"\([^"]*\)".*/    \1  \2\/100  (\3)/p'
  fi
  return 0
}

# ── status ───────────────────────────────────────────────────────────────────

brain_status() {
  local d; d="$(brain_dir)"
  if ! brain_is_repo "$d"; then
    echo "brain: NOT INITIALIZED (would live at $d) — run 'myai brain init'"
    return 1
  fi
  local branch atoms_m atoms_s atoms_h nss last
  branch="$(git -C "$d" rev-parse --abbrev-ref HEAD)"
  atoms_m="$(find "$d/memory" -name '*.md' -not -name '.gitkeep' 2>/dev/null | wc -l | tr -d ' ')"
  atoms_s="$(find "$d/repos" -path '*/sessions/*.md' 2>/dev/null | wc -l | tr -d ' ')"
  atoms_h="$(find "$d/repos" -path '*/handoffs/*.md' 2>/dev/null | wc -l | tr -d ' ')"
  nss="$(find "$d/repos" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  last="$(git -C "$d" log -1 --format='%h %s (%cr)' 2>/dev/null)"
  echo "brain: $d"
  echo "  branch:     $branch"
  echo "  namespaces: $nss"
  echo "  atoms:      $atoms_s sessions · $atoms_h handoffs · $atoms_m memory"
  echo "  last:       ${last:-—}"
  local br
  br="$(git -C "$d" for-each-ref --format='%(refname:short)' 'refs/heads/session/*' 'refs/heads/idea/*' 2>/dev/null | tr '\n' ' ')"
  [ -n "$br" ] && echo "  branches:   $br"
  local st
  st="$(brain_stash_list | grep -c . || true)"
  [ "$st" != "0" ] && echo "  stashes:    $st waiting (resume with 'myai brain pop')"
  brain_health
  return 0
}
