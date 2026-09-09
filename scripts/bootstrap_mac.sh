#!/usr/bin/env bash
# bootstrap_mac.sh — take a BLANK Mac to this fleet's working state.
#
# WHY THIS EXISTS: every machine swap so far has been rediscovery-by-failure —
# a missing `jq` that silently kills every session hook, two `node` installs
# where PATH order silently decides which one you get, an npm prefix owned by
# root that EACCESs the first global install, SSH keys that were never
# registered, an unaccepted Xcode licence that reads like a broken git. The repo
# already had the *arrival* scripts (myai_setup_machine.sh, setup_org_dirs.sh,
# machine_selfheal.sh) but they all assume Homebrew, Node, Docker and a CLONE
# already exist. This is the layer BELOW those: bare metal to first `claude`.
#
# It is deliberately Claude-free. It is plain bash + brew, runs on the stock
# macOS bash 3.2, and needs no agent, no gateway and no API key. That is the
# point — you run this on day one, before anything intelligent is available.
#
# WHAT IT INSTALLS is DATA, not code: config/machine_manifest.txt. Refresh that
# from a known-good machine with `--scan` and commit the diff, and this stays a
# living migration tool instead of a snapshot of one afternoon in August 2026.
#
# Usage:
#   ./scripts/bootstrap_mac.sh                  run every stage (prompts before
#                                                 anything slow or irreversible)
#   ./scripts/bootstrap_mac.sh --dry-run        print the plan, change nothing
#   ./scripts/bootstrap_mac.sh --yes            non-interactive, assume yes
#   ./scripts/bootstrap_mac.sh --only node      run one stage
#   ./scripts/bootstrap_mac.sh --skip casks     run all but one (repeatable)
#   ./scripts/bootstrap_mac.sh --list           list the stages
#   ./scripts/bootstrap_mac.sh --scan           regenerate the manifest from
#                                                 THIS machine, then exit
#   ./scripts/bootstrap_mac.sh --verify         report drift vs the manifest
#
# Bootstrapping with no repo yet (the real day-one path):
#   curl -fsSL https://raw.githubusercontent.com/knofler/ai_management/main/scripts/bootstrap_mac.sh -o /tmp/bootstrap_mac.sh
#   bash /tmp/bootstrap_mac.sh
# Run standalone it installs the base layer, clones the repo, then re-execs
# itself from the clone so the manifest-driven stages have their data.
#
# Idempotent: every stage checks before it acts and reports OK on a healthy
# machine. Safe to re-run as often as you like.
#
# Runbook: documentation/MACHINE_SETUP.md
# Tests:   scripts/tests/test_bootstrap_mac.sh
set -uo pipefail

# ── locations ────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
REPO_DIR="$(cd "$HERE/.." 2>/dev/null && pwd)"
MANIFEST="$REPO_DIR/config/machine_manifest.txt"
# Where the fleet lives. Override with MYAI_WORKSPACE (e.g. point it at a
# cloud-synced folder). The default keeps the `_MY_PROJECT/AI` container marker
# that scripts/lib/repo_id.sh keys the master checkout on.
WORKSPACE="${MYAI_WORKSPACE:-$HOME/_MY_PROJECT}"
REPO_URL="${MYAI_REPO_URL:-git@github.com:knofler/ai_management.git}"
REPO_URL_HTTPS="https://github.com/knofler/ai_management.git"

STAGES="preflight xcode brew formulae casks node shell ssh git repo claude myai editors verify"

DRY_RUN=0; ASSUME_YES=0; ONLY=""; SKIP=""; MODE="install"

# ── output ───────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=""; DIM=""; G=""; Y=""; R=""; C=""; N=""
fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '  %sok%s   %s\n'   "$G" "$N" "$*"; }
warn() { printf '  %swarn%s %s\n'   "$Y" "$N" "$*"; WARNINGS=$((WARNINGS+1)); }
fail() { printf '  %sFAIL%s %s\n'   "$R" "$N" "$*"; FAILURES=$((FAILURES+1)); }
info() { printf '  %s->%s   %s\n'   "$C" "$N" "$*"; }
todo() { printf '  %sTODO%s %s\n'   "$Y" "$N" "$*"; TODOS="$TODOS
  - $*"; }
head2(){ printf '\n%s-- %s%s\n' "$B" "$*" "$N"; }
WARNINGS=0; FAILURES=0; TODOS=""; CHANGED=0

# Run a command, or print it under --dry-run. Args are passed through verbatim
# (no eval) so this stays injection-free even when the manifest is edited.
run() {
  if [ "$DRY_RUN" = "1" ]; then printf '  %s[dry-run]%s %s\n' "$DIM" "$N" "$*"; return 0; fi
  "$@"; local rc=$?
  [ $rc -eq 0 ] && CHANGED=$((CHANGED+1))
  return $rc
}

# Same as run(), but swallows the command's own chatter. Callers must NOT
# redirect run() themselves: `run foo >/dev/null` also eats the [dry-run] line,
# which made a dry-run print "installed X" for things it had not touched.
run_quiet() {
  if [ "$DRY_RUN" = "1" ]; then printf '  %s[dry-run]%s %s\n' "$DIM" "$N" "$*"; return 0; fi
  "$@" >/dev/null 2>&1; local rc=$?
  [ $rc -eq 0 ] && CHANGED=$((CHANGED+1))
  return $rc
}

# Success message that stays quiet under --dry-run, so the [dry-run] line above
# is the only thing a preview prints. Pairs with run_quiet.
did() { [ "$DRY_RUN" = "1" ] || ok "$*"; }

# Ask before anything slow, large or irreversible. --yes and --dry-run skip it.
confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  [ "$DRY_RUN" = "1" ] && return 0
  [ -t 0 ] || { warn "not a tty and no --yes — skipping: $1"; return 1; }
  printf '  %s?%s %s [y/N] ' "$Y" "$N" "$1"
  read -r _ans
  case "$_ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# ── manifest parsing (bash 3.2: no associative arrays) ───────────────────────
# Emit the entries of one [section]. Comments and blanks stripped.
manifest_section() {
  [ -f "$MANIFEST" ] || return 0
  awk -v want="$1" '
    /^\[/ { sec = substr($0, 2, index($0,"]")-2); next }
    sec == want {
      sub(/[ \t]+$/, "")
      if ($0 ~ /^[ \t]*#/ || $0 ~ /^[ \t]*$/) next
      print
    }
  ' "$MANIFEST"
}

# ── stages ───────────────────────────────────────────────────────────────────

stage_preflight() {
  head2 "preflight"
  local arch os
  arch="$(uname -m)"; os="$(sw_vers -productVersion 2>/dev/null)"
  info "macOS $os on $arch, host $(hostname -s)"
  case "$arch" in
    arm64) ok "Apple Silicon — brew prefix /opt/homebrew" ;;
    x86_64) warn "Intel Mac — brew prefix /usr/local; the fleet's Docker images are arm64-first and will run under emulation" ;;
  esac
  # A blank Mac's bash is 3.2. Everything here must survive that; assert it
  # rather than discover it via a syntax error halfway through.
  if [ -n "${BASH_VERSION:-}" ]; then info "bash ${BASH_VERSION%%(*}"; fi
  if [ ! -d "$HOME/Dropbox" ]; then
    todo "Install Dropbox and let it finish the initial sync BEFORE the 'repo' stage — a Dropbox-synced workspace lives under \$HOME/Dropbox"
  else
    ok "Dropbox present"
  fi
  if [ -f "$MANIFEST" ]; then ok "manifest: $MANIFEST"; else warn "manifest not found (running standalone — will clone first)"; fi
}

stage_xcode() {
  head2 "xcode command line tools"
  if xcode-select -p >/dev/null 2>&1; then
    ok "CLT active at $(xcode-select -p)"
  else
    info "installing Command Line Tools (a GUI dialog will open — accept it, then re-run)"
    run xcode-select --install
    todo "Finish the Xcode CLT GUI installer, then re-run this script"
    return 0
  fi
  if [ ! -d /Applications/Xcode.app ]; then
    todo "Full Xcode from the Mac App Store (only needed for iOS/macOS app builds — the CLT above covers everything else)"
  else
    ok "Xcode.app present"
    # A fresh Xcode has never had its licence accepted; git and brew both fail
    # with a licence error until it has, which reads like a broken toolchain.
    if ! /usr/bin/xcrun clang --version >/dev/null 2>&1; then
      todo "Run: sudo xcodebuild -license accept"
    fi
  fi
}

stage_brew() {
  head2 "homebrew"
  if have brew; then
    ok "brew $(brew --version 2>/dev/null | head -1 | awk '{print $2}')"
  else
    confirm "Install Homebrew (downloads + compiles, takes a while)?" || { warn "skipped — nothing below this line can run"; return 1; }
    run /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || { fail "Homebrew install failed"; return 1; }
  fi
  # Put brew on PATH for the rest of THIS run and for future shells.
  local prefix
  if [ "$(uname -m)" = "arm64" ]; then prefix=/opt/homebrew; else prefix=/usr/local; fi
  if [ -x "$prefix/bin/brew" ]; then
    eval "$("$prefix/bin/brew" shellenv)" 2>/dev/null
    ensure_zprofile_line "eval \"\$($prefix/bin/brew shellenv)\"" "homebrew shellenv"
  fi
}

stage_formulae() {
  head2 "brew formulae"
  have brew || { fail "no brew — run the brew stage first"; return 1; }
  local t f installed nprefix
  for t in $(manifest_section brew_tap); do
    if brew tap 2>/dev/null | grep -qx "$t"; then ok "tap $t"; else run brew tap "$t" && ok "tapped $t"; fi
  done
  installed="$(brew list --formula 2>/dev/null)"
  for f in $(manifest_section brew_formula); do
    if printf '%s\n' "$installed" | grep -qx "$f"; then
      ok "$f"
    else
      run_quiet brew install "$f" && did "installed $f" || fail "brew install $f"
    fi
  done
  # A versioned `node@NN` formula is keg-only — its bin is NOT linked, so without
  # this `node` on PATH stays whatever else is there. The bare `node` formula IS
  # linked and needs none of it. Read whichever the manifest asked for rather
  # than hard-coding a major here, so re-pinning is a one-line manifest edit.
  local pinned_node
  pinned_node="$(manifest_section brew_formula | grep -E '^node@[0-9]+$' | head -1)"
  if [ -n "$pinned_node" ] && brew list --formula 2>/dev/null | grep -qx "$pinned_node"; then
    nprefix="$(brew --prefix "$pinned_node" 2>/dev/null)"
    if [ -n "$nprefix" ] && [ -d "$nprefix/bin" ]; then
      ensure_zprofile_line "export PATH=\"$nprefix/bin:\$PATH\"" "$pinned_node on PATH"
      export PATH="$nprefix/bin:$PATH"
    fi
  fi
}

stage_casks() {
  head2 "brew casks"
  have brew || { fail "no brew"; return 1; }
  local c app installed
  installed="$(brew list --cask 2>/dev/null)"
  for c in $(manifest_section brew_cask); do
    if printf '%s\n' "$installed" | grep -qx "$c"; then ok "$c"; continue; fi
    # An MDM-managed Mac often already has the app from Self Service. Installing
    # the cask over it fights Jamf and can leave two copies; detect and skip.
    app=""
    case "$c" in
      docker-desktop)      app="/Applications/Docker.app" ;;
      visual-studio-code)  app="/Applications/Visual Studio Code.app" ;;
      cursor)              app="/Applications/Cursor.app" ;;
      claude)              app="/Applications/Claude.app" ;;
      iterm2)              app="/Applications/iTerm.app" ;;
      mongodb-compass)     app="/Applications/MongoDB Compass.app" ;;
      bruno)               app="/Applications/Bruno.app" ;;
      proxyman)            app="/Applications/Proxyman.app" ;;
      powershell)          app="/Applications/PowerShell.app" ;;
    esac
    if [ -n "$app" ] && [ -d "$app" ]; then
      ok "$c (already installed outside brew — left alone)"
      continue
    fi
    if confirm "brew install --cask $c ?"; then
      run_quiet brew install --cask "$c" && did "installed $c" || warn "cask $c failed (often MDM-blocked — get it from Self Service)"
    else
      todo "Install $c manually"
    fi
  done
  head2 "apps no package manager owns"
  local name where why
  manifest_section app_manual | while IFS='|' read -r name where why; do
    [ -z "$name" ] && continue
    if [ -d "/Applications/$name" ]; then printf '  %sok%s   %s\n' "$G" "$N" "$name"
    else printf '  %sTODO%s %s — %s (%s)\n' "$Y" "$N" "$name" "$why" "$where"; fi
  done
}

stage_node() {
  head2 "node + global npm packages"
  have node || { fail "node missing — run the formulae stage"; return 1; }
  local nv prefix pkg globals
  nv="$(node -v 2>/dev/null)"
  # The manifest asks for the CURRENT node by default (bare `node`), so the
  # check is "are we behind what brew ships today", not "does this equal a
  # frozen major". A machine built a year ago and never touched is exactly the
  # staleness this is here to surface.
  local want_major have_major
  have_major="$(printf '%s' "$nv" | sed 's/^v//; s/\..*//')"
  want_major="$(brew info --json=v2 node 2>/dev/null | jq -r '.formulae[0].versions.stable' 2>/dev/null | sed 's/\..*//')"
  if [ -z "$have_major" ]; then
    fail "node reports no version"
  elif [ "$have_major" -lt 20 ] 2>/dev/null; then
    fail "node $nv is below the >=20 floor this repo's engines declare — upgrade: brew install node"
  elif [ -n "$want_major" ] && [ "$have_major" -lt "$want_major" ] 2>/dev/null; then
    warn "node $nv — brew currently ships v$want_major. The manifest asks for CURRENT node; upgrade with: brew upgrade node"
  else
    ok "node $nv (current)"
  fi
  # Two nodes on one machine is how the version you actually get becomes a
  # function of PATH order rather than a decision. Say so out loud.
  local ncount
  ncount="$(command -v -a node 2>/dev/null | sort -u | wc -l | tr -d ' ')"
  if [ "${ncount:-1}" -gt 1 ] 2>/dev/null; then
    warn "$ncount node installs on PATH — the first one wins by accident, not by choice:"
    command -v -a node 2>/dev/null | sort -u | while read -r np; do printf '         %s -> %s\n' "$np" "$("$np" -v 2>/dev/null)"; done
  fi
  # A root-owned npm prefix EACCESs the first global install and is the single
  # most common day-one failure; npm_prefix_preflight.sh exists for exactly this.
  #
  # --fix, not check-only. This is worse than a failed install: on 2026-08-31
  # this machine had `myai` resolving to ~/.local/lib/node_modules while npm's
  # prefix pointed at an unwritable /usr/local, so `npm i -g ai-management`
  # could not write AND would have installed somewhere PATH never looks. The
  # module sat on 0.6.4 while 0.8.0 shipped — four releases — and because the
  # kernel model resolves every repo's framework from that module, every kernel
  # repo on the machine was silently running the old one. A new Mac must never
  # be able to reach that state, and redirecting the prefix to ~/.local is both
  # reversible and what the fleet already standardises on.
  if [ -x "$REPO_DIR/scripts/npm_prefix_preflight.sh" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      run "$REPO_DIR/scripts/npm_prefix_preflight.sh" --fix
    elif "$REPO_DIR/scripts/npm_prefix_preflight.sh" --fix --quiet; then
      ok "npm prefix healthy ($(npm config get prefix 2>/dev/null))"
    else
      warn "npm prefix still unwritable after --fix — run scripts/npm_prefix_preflight.sh for the corrective command"
    fi
  else
    prefix="$(npm config get prefix 2>/dev/null)"
    if [ -n "$prefix" ] && [ -d "$prefix" ] && [ ! -w "$prefix" ]; then
      warn "npm prefix $prefix is not writable — global installs will EACCES. Fix: sudo chown -R \$(whoami) $prefix"
    else
      ok "npm prefix $prefix writable"
    fi
  fi
  have corepack && run_quiet corepack enable
  globals="$(npm ls -g --depth=0 --parseable 2>/dev/null)"
  for pkg in $(manifest_section npm_global); do
    if printf '%s\n' "$globals" | grep -q "/$pkg\$"; then
      ok "$pkg"
    else
      run_quiet npm i -g "$pkg" && did "installed $pkg" || fail "npm i -g $pkg"
    fi
  done
  check_global_staleness
}

# WHY THIS IS NOT OPTIONAL: under the kernel model, a repo carrying only a
# 30-line CLAUDE.md resolves ALL of its agents, skills, hooks and rule bodies at
# runtime from the globally-installed ai-management module (`myai root`). So a
# stale global silently degrades EVERY kernel repo on the machine at once, with
# no warning anywhere. This machine sat on 0.6.4 while 0.8.0 was published —
# four releases — and nothing said a word.
check_global_staleness() {
  have npm || return 0
  local outdated cur want pkg
  outdated="$(npm outdated -g --json 2>/dev/null)"
  [ -z "$outdated" ] && return 0
  for pkg in $(manifest_section npm_global); do
    cur="$(printf '%s' "$outdated"  | jq -r --arg p "$pkg" '.[$p].current // empty' 2>/dev/null)"
    want="$(printf '%s' "$outdated" | jq -r --arg p "$pkg" '.[$p].latest  // empty' 2>/dev/null)"
    [ -z "$cur" ] || [ -z "$want" ] && continue
    [ "$cur" = "$want" ] && continue
    if [ "$pkg" = "ai-management" ]; then
      warn "ai-management $cur -> $want available. EVERY kernel repo on this machine resolves its framework from this module, so all of them are running $cur. Update: npm i -g ai-management"
    else
      warn "$pkg $cur -> $want available (npm i -g $pkg)"
    fi
  done
}

# Append a line to ~/.zprofile inside a managed, idempotent block. Never
# duplicates; skips if the exact line is already present.
ensure_zprofile_line() {
  local line="$1" label="$2" file="$HOME/.zprofile"
  if [ -f "$file" ] && grep -Fqx "$line" "$file"; then ok "$label (already in .zprofile)"; return 0; fi
  if [ "$DRY_RUN" = "1" ]; then printf '  %s[dry-run]%s add to .zprofile: %s\n' "$DIM" "$N" "$line"; return 0; fi
  printf '\n# %s (managed by bootstrap_mac.sh)\n%s\n' "$label" "$line" >> "$file"
  ok "added to .zprofile: $label"
  CHANGED=$((CHANGED+1))
}

stage_shell() {
  head2 "shell environment"
  ensure_zprofile_line 'export PATH="$HOME/.local/bin:$PATH"' '~/.local/bin on PATH (claude + myai live here)'
  local zshrc="$HOME/.zshrc"
  if [ ! -f "$zshrc" ] && [ "$DRY_RUN" != "1" ]; then : > "$zshrc"; fi
  # direnv: per-repo env without exporting secrets globally.
  if have direnv; then
    if grep -q 'direnv hook zsh' "$zshrc" 2>/dev/null; then ok "direnv hook"
    else
      if [ "$DRY_RUN" = "1" ]; then info "[dry-run] add direnv hook to .zshrc"
      else printf '\n# >>> direnv hook (managed) >>>\neval "$(direnv hook zsh)"\n# <<< direnv hook <<<\n' >> "$zshrc"; ok "added direnv hook"; fi
    fi
  else
    warn "direnv not installed"
  fi
  # Project .env autoload. Claude Code expands ${VAR} in .mcp.json from the
  # SHELL environment, so an unloaded .env means every MCP server with a
  # templated key silently starts unauthenticated.
  if grep -q '_load_project_dotenv' "$zshrc" 2>/dev/null; then
    ok "project .env autoload"
  elif [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] add project .env autoload to .zshrc"
  else
    cat >> "$zshrc" <<'ZBLOCK'

# --- Auto-load project .env into the shell (so Claude Code MCP ${VAR} expansion sees it) ---
# Loads ./.env on shell start and on every `cd` into a dir that has one.
_load_project_dotenv() { [ -f .env ] && { set -a; source ./.env; set +a; } }
autoload -U add-zsh-hook 2>/dev/null && add-zsh-hook chpwd _load_project_dotenv
_load_project_dotenv
ZBLOCK
    ok "added project .env autoload"
  fi
}

stage_ssh() {
  head2 "ssh keys"
  local dir="$HOME/.ssh" name label
  [ -d "$dir" ] || run mkdir -p "$dir"
  [ -d "$dir" ] && chmod 700 "$dir" 2>/dev/null
  manifest_section ssh_key | while IFS='|' read -r name label; do
    [ -z "$name" ] && continue
    if [ -f "$dir/$name" ]; then
      printf '  %sok%s   %s (%s)\n' "$G" "$N" "$name" "$label"
    elif [ "$DRY_RUN" = "1" ]; then
      printf '  %s[dry-run]%s ssh-keygen -t ed25519 -f %s\n' "$DIM" "$N" "$dir/$name"
    else
      ssh-keygen -t ed25519 -f "$dir/$name" -N "" -C "$(whoami)@$(hostname -s)" >/dev/null 2>&1
      printf '  %sok%s   generated %s — register this public key with %s:\n' "$G" "$N" "$name" "$label"
      printf '       %s\n' "$(cat "$dir/$name.pub" 2>/dev/null)"
    fi
  done
  # Minimal config so `git@github.com` picks the fleet key rather than whatever
  # ssh-agent happens to offer first.
  if [ -f "$dir/config" ] && grep -q 'Host github.com' "$dir/config" 2>/dev/null; then
    ok "~/.ssh/config has a github.com entry"
  elif [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] add github.com block to ~/.ssh/config"
  else
    cat >> "$dir/config" <<'SSHCFG'

Host github.com
  User git
  IdentityFile ~/.ssh/github_key
  IdentitiesOnly yes
SSHCFG
    chmod 600 "$dir/config" 2>/dev/null
    ok "added github.com block to ~/.ssh/config"
  fi
  todo "Add the printed public key(s) to GitHub (Settings > SSH keys) and Azure DevOps before the 'repo' stage"
}

stage_git() {
  head2 "git + gh"
  have git || { fail "git missing"; return 1; }
  ok "$(git --version)"
  # Identity. Keep --global to these two only: the project's git-email rule
  # depends on per-repo noreply overrides staying per-repo.
  local email; email="$(git config --global user.email 2>/dev/null)"
  if [ -n "$email" ]; then ok "git user.email = $email"
  else todo "Set your git identity: git config --global user.name '<name>' && git config --global user.email '<email>'"; fi
  if have gh; then
    if gh auth status >/dev/null 2>&1; then
      ok "gh authenticated"
      # Make gh the credential helper so HTTPS remotes work without a PAT prompt.
      if git config --global --get-regexp 'credential.*helper' 2>/dev/null | grep -q 'gh auth git-credential'; then
        ok "gh is the git credential helper"
      else
        run gh auth setup-git && ok "gh set as git credential helper"
      fi
    else
      todo "Authenticate GitHub: gh auth login   (choose SSH, and upload ~/.ssh/github_key.pub when offered)"
    fi
  else
    fail "gh missing — run the formulae stage"
  fi
  if have az; then
    if az account show >/dev/null 2>&1; then ok "az authenticated"; else todo "Authenticate Azure: az login"; fi
  fi
}

stage_repo() {
  head2 "workspace + ai_management clone"
  if [ ! -d "$HOME/Dropbox" ]; then
    todo "Dropbox is not installed/synced — the workspace cannot be restored yet. Install Dropbox, let it sync, then re-run --only repo"
    return 0
  fi
  [ -d "$WORKSPACE" ] || run mkdir -p "$WORKSPACE"
  local target="$WORKSPACE/AI"
  if [ -d "$target/.git" ]; then
    ok "ai_management already cloned at $target"
  elif [ -d "$target" ]; then
    # Dropbox is known to drop `.git` on sync; restore_git_metadata.sh is the
    # dedicated repair for exactly this, so point at it rather than re-cloning
    # over what could be uncommitted work.
    warn "$target exists but has no .git — Dropbox likely purged it"
    todo "Repair with: $target/scripts/restore_git_metadata.sh   (do NOT delete and re-clone; there may be uncommitted work)"
  else
    if confirm "Clone ai_management into $target ?"; then
      run git clone "$REPO_URL" "$target" || {
        warn "SSH clone failed — falling back to HTTPS (needs gh auth)"
        run git clone "$REPO_URL_HTTPS" "$target" || fail "clone failed"
      }
    else
      todo "Clone the repo: git clone $REPO_URL $target"
    fi
  fi
  if [ -x "$target/scripts/install_git_hooks.sh" ]; then
    run_quiet "$target/scripts/install_git_hooks.sh" && did "git hooks installed (pre-push local-ci)" || warn "install_git_hooks.sh failed"
  fi
  todo "Restore the repo's .env from your password manager — it is gitignored by design and nothing here can recreate it"
}

stage_claude() {
  head2 "claude code + the three accounts"
  if have claude; then
    ok "claude $(claude --version 2>/dev/null | head -1)"
  else
    if confirm "Install Claude Code CLI?"; then
      run /bin/bash -c "$(curl -fsSL https://claude.ai/install.sh)" || todo "Install Claude Code: see https://docs.claude.com/claude-code"
    else
      todo "Install Claude Code CLI"
    fi
  fi
  # Per-org config dirs + aliases. setup_org_dirs.sh owns this; do not
  # reimplement it here or the two will drift.
  local orgscript="$REPO_DIR/scripts/setup_org_dirs.sh"
  [ -x "$orgscript" ] || orgscript="$WORKSPACE/AI/scripts/setup_org_dirs.sh"
  if [ -x "$orgscript" ]; then
    if [ "$DRY_RUN" = "1" ]; then run "$orgscript" --dry-run
    else run "$orgscript" && ok "org dirs + aliases installed"; fi
  else
    warn "setup_org_dirs.sh not found — run the repo stage first"
  fi
  local alias_name dir label expanded
  manifest_section claude_profile | while IFS='|' read -r alias_name dir label; do
    [ -z "$alias_name" ] && continue
    expanded="$(printf '%s' "$dir" | sed "s#^~#$HOME#")"
    if [ -d "$expanded" ]; then printf '  %sok%s   %s -> %s (%s)\n' "$G" "$N" "$alias_name" "$dir" "$label"
    else printf '  %sTODO%s %s -> %s (%s) — not created yet\n' "$Y" "$N" "$alias_name" "$dir" "$label"; fi
  done
  todo "Authenticate each account ONCE, in its own shell: run 'claude-museum' then /login, 'claude-tech' then /login, 'claude-personal' then /login. Auth is per CLAUDE_CONFIG_DIR — logging into one does NOT log into the others"
}

stage_myai() {
  head2 "myai gateway + runner"
  if have myai; then ok "myai $(myai --version 2>/dev/null | head -1)"
  else todo "Install the CLI: npm i -g ai-management"; fi
  if have docker && docker info >/dev/null 2>&1; then
    ok "docker daemon reachable"
  else
    todo "Start Docker Desktop and let the daemon come up — the gateway, dashboard and mongo all run in it"
    return 0
  fi
  # myai_setup_machine.sh is THE arrival orchestrator (Dropbox conflicts, npm
  # prefix, git metadata, runner registration, docker rebuild). Hand off to it
  # rather than duplicating any of its five sub-scripts.
  local setup="$REPO_DIR/scripts/myai_setup_machine.sh"
  [ -x "$setup" ] || setup="$WORKSPACE/AI/scripts/myai_setup_machine.sh"
  if [ -x "$setup" ]; then
    if [ "$DRY_RUN" = "1" ]; then run "$setup" --dry-run
    else
      info "handing off to myai setup --machine (report-only; add --yes there to install the runner + rebuild Docker)"
      run "$setup"
    fi
  else
    warn "myai_setup_machine.sh not found — run the repo stage first"
  fi
  todo "Bring the stack up: cd $WORKSPACE/AI && docker compose up -d --build   then check http://localhost:3100/health and the dashboard on :3210"
}

stage_editors() {
  head2 "editor extensions"
  local bin="" installed ext
  have code && bin=code
  if [ -z "$bin" ] && [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
    bin="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  fi
  if [ -z "$bin" ]; then
    todo "VS Code 'code' command not on PATH — open VS Code and run: Shell Command: Install 'code' command in PATH, then re-run --only editors"
    return 0
  fi
  installed="$("$bin" --list-extensions 2>/dev/null | tr 'A-Z' 'a-z')"
  for ext in $(manifest_section vscode_ext); do
    if printf '%s\n' "$installed" | grep -qx "$(printf '%s' "$ext" | tr 'A-Z' 'a-z')"; then
      ok "$ext"
    else
      run_quiet "$bin" --install-extension "$ext" --force && did "installed $ext" || warn "$ext failed"
    fi
  done
}

stage_verify() {
  head2 "verify"
  local t p missing=0
  for t in brew git gh node npm docker jq mongosh atlas az direnv tmux uv claude myai; do
    p="$(command -v "$t" 2>/dev/null)"
    if [ -n "$p" ]; then printf '  %sok%s   %-9s %s\n' "$G" "$N" "$t" "$p"
    else printf '  %sFAIL%s %-9s missing\n' "$R" "$N" "$t"; missing=$((missing+1)); fi
  done
  [ "$missing" -gt 0 ] && FAILURES=$((FAILURES+missing))
  if docker info >/dev/null 2>&1; then ok "docker daemon up"; else warn "docker daemon down"; fi
  if curl -fsS --max-time 3 http://localhost:3100/health >/dev/null 2>&1; then ok "myai gateway healthy on :3100"
  else warn "myai gateway not responding on :3100 (expected until 'docker compose up -d --build')"; fi
  check_container_node
}

# The other half of "is this machine current". The host Node is unpinned and
# moves on its own; the CONTAINER base images are pinned in the Dockerfiles and
# move only when someone edits them. Nothing compared the two, so the containers
# quietly aged while every report said the machine was healthy — which is how
# they ended up several majors behind without it ever surfacing.
check_container_node() {
  local files majors newest host_major f
  files="$(ls "$REPO_DIR"/runtime/Dockerfile "$REPO_DIR"/dashboard/Dockerfile \
              "$REPO_DIR"/mcp/Dockerfile "$REPO_DIR"/templates/blueprint/Dockerfile 2>/dev/null)"
  [ -z "$files" ] && return 0
  majors="$(grep -ho '^FROM node:[0-9]*' $files 2>/dev/null | sed 's/.*node://' | sort -un | tr '\n' ' ')"
  [ -z "$majors" ] && return 0
  newest="$(printf '%s' "$majors" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -n | tail -1)"
  host_major="$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')"
  if [ -n "$host_major" ] && [ -n "$newest" ] && [ "$host_major" -gt "$newest" ] 2>/dev/null; then
    warn "container base images are on node:${majors% } while the host runs v$host_major — the containers are the half that lags. Bump the FROM lines in runtime/, dashboard/, mcp/ and templates/blueprint/ Dockerfiles (tracked as its own task)"
  else
    ok "container base images: node:${majors% }"
  fi
}

# ── --scan: regenerate the manifest from THIS machine ────────────────────────
do_scan() {
  local out="$MANIFEST" s
  say "Scanning $(hostname -s) -> $out"
  {
    printf '# machine_manifest.txt — regenerated by scripts/bootstrap_mac.sh --scan\n'
    printf '# Source: %s (macOS %s, %s) — %s\n' "$(hostname -s)" "$(sw_vers -productVersion)" "$(uname -m)" "$(date +%Y-%m-%d)"
    printf '#\n# Hand-written sections ([app_manual], [ssh_key], [claude_profile]) are\n'
    printf '# PRESERVED from the previous manifest — a scan cannot infer intent for those.\n'
    printf '\n[brew_tap]\n';     brew tap 2>/dev/null
    printf '\n[brew_formula]\n'; brew leaves 2>/dev/null
    printf '\n[brew_cask]\n';    brew list --cask 2>/dev/null
    printf '\n[npm_global]\n';   npm ls -g --depth=0 --parseable 2>/dev/null | sed '1d' | sed 's#.*/node_modules/##'
    printf '\n[vscode_ext]\n';   (command -v code >/dev/null 2>&1 && code --list-extensions 2>/dev/null)
    # Carry the intent-bearing sections forward verbatim.
    for s in app_manual ssh_key claude_profile; do
      printf '\n[%s]\n' "$s"; manifest_section "$s"
    done
  } > "$out.tmp" 2>/dev/null
  if [ "$DRY_RUN" = "1" ]; then cat "$out.tmp" 2>/dev/null; unlink "$out.tmp" 2>/dev/null; return 0; fi
  mv "$out.tmp" "$out"
  say "Wrote $out — review the diff and commit it."
}

# ── argument parsing ─────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    --only)    ONLY="${2:-}"; shift ;;
    --skip)    SKIP="$SKIP ${2:-}"; shift ;;
    --scan)    MODE="scan" ;;
    --verify)  ONLY="verify" ;;
    --list)    say "stages: $STAGES"; exit 0 ;;
    -h|--help) sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) say "unknown option: $1 (try --help)"; exit 2 ;;
  esac
  shift
done

# ── main ─────────────────────────────────────────────────────────────────────
say "${B}bootstrap_mac.sh${N} — blank Mac -> fleet-ready"
[ "$DRY_RUN" = "1" ] && say "${DIM}dry-run: nothing will be changed${N}"

if [ "$MODE" = "scan" ]; then do_scan; exit 0; fi

# Standalone (curl'd, no repo): do the base layer, clone, then re-exec from the
# clone so the manifest-driven stages have their data.
if [ ! -f "$MANIFEST" ] && [ -z "$ONLY" ]; then
  say "${Y}No manifest here — running standalone. Base layer + clone, then re-exec.${N}"
  stage_preflight; stage_xcode; stage_brew; stage_shell; stage_ssh; stage_git; stage_repo
  CLONED="$WORKSPACE/AI/scripts/bootstrap_mac.sh"
  if [ -x "$CLONED" ] && [ "$DRY_RUN" != "1" ]; then
    say ""
    say "${B}Re-executing from the clone${N} -> $CLONED"
    if [ "$ASSUME_YES" = "1" ]; then exec "$CLONED" --yes; else exec "$CLONED"; fi
  fi
  say ""
  say "Clone the repo, then re-run: $WORKSPACE/AI/scripts/bootstrap_mac.sh"
  exit 0
fi

for s in $STAGES; do
  if [ -n "$ONLY" ] && [ "$s" != "$ONLY" ]; then continue; fi
  case " $SKIP " in *" $s "*) say ""; say "${DIM}-- skipping $s${N}"; continue ;; esac
  "stage_$s"
done

# ── report ───────────────────────────────────────────────────────────────────
say ""
say "${B}--------------------------------------------------------${N}"
printf '%s SUMMARY%s  changed=%s  warnings=%s  failures=%s\n' "$B" "$N" "$CHANGED" "$WARNINGS" "$FAILURES"
if [ -n "$TODOS" ]; then
  say ""
  say "${Y}${B}OPERATOR TODO — these need a human:${N}${TODOS}"
fi
say ""
say "Runbook: documentation/MACHINE_SETUP.md"
[ "$FAILURES" -gt 0 ] && exit 1
exit 0
