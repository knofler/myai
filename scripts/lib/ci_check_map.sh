# ci_check_map.sh — map a branch-protection required-check context name to the
# local npm script (or generic gate) local-ci.sh should run for it.
#
# WHY: local-ci.sh's built-in mapping only recognized this repo's own context
# names ("Enforce branch policy", "Security Audit", "build", "Ready to Merge").
# Any repo whose GitHub Actions jobs are named differently — e.g. agentFlow's
# "Lint" / "Type-check" / "Test" / "Audit" — fell through to "no local runner
# mapped" and silently skipped posting for every one of those checks, even
# though a straightforward `npm run lint`/`npm run typecheck`/`npm run test`/
# `npm audit` mapping exists. (task-3fa03a74-f489-4b65-b72e-290130e22e59)
#
# Sourced by scripts/local-ci.sh. No side effects on source.

# ci_norm_ctx <name> — lowercase, strip spaces/hyphens/underscores, so
# "Type-check", "type_check", "TYPECHECK" etc. all compare equal.
ci_norm_ctx() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d ' _-'
}

# ci_map_npm_scripts <context-name> — echoes a space-separated, ordered list of
# candidate package.json script names to try for this context, or nothing if
# there's no known mapping. The caller runs the first one that actually exists.
ci_map_npm_scripts() {
  case "$(ci_norm_ctx "$1")" in
    lint)                        echo "lint" ;;
    typecheck|tsc|types)         echo "typecheck type-check" ;;
    test|tests|unittest|unittests) echo "test" ;;
  esac
}

# ci_map_audit <context-name> — true (exit 0) if this context name should run
# the generic npm-audit gate. Bare "Audit" only — "Security Audit" already has
# its own dedicated built-in mapping in local-ci.sh and is matched before this
# is ever consulted.
ci_map_audit() {
  case "$(ci_norm_ctx "$1")" in
    audit|npmaudit) return 0 ;;
    *) return 1 ;;
  esac
}
