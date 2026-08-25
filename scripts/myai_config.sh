#!/usr/bin/env bash
# myai_config.sh — the `myai config` safe config front-end: view/set the
# per-user `~/.myai/config` (JSON) keys with SCHEMA VALIDATION + secret
# redaction, replacing error-prone hand-editing of the file (task-c118119c).
#
# Usage:
#   myai config                        # same as `config list`
#   myai config list [--json][--reveal]# every key currently set, values
#                                      #   redacted where secret-shaped; keys
#                                      #   not in the schema are flagged
#   myai config keys [--json]          # the SCHEMA: every known key, its type,
#                                      #   validation rule, and description
#   myai config get <key> [--reveal]   # print one value (redacted unless
#              [--json]                #   --reveal); exit 3 when not set
#   myai config set <key> <value>      # validate against the schema, then
#              [--force]               #   write. Unknown keys are REFUSED
#                                      #   (--force overrides, with a warning);
#                                      #   secret-named keys are ALWAYS refused
#                                      #   (config never holds credentials —
#                                      #   ~/.myai/credentials + `myai login` /
#                                      #   `myai rotate-keys` own those)
#   myai config unset <key>            # remove a key (empty parents pruned) —
#                                      #   the cleanup path for unknown keys
#   myai config path                   # print the config file path
#
# The schema (see `myai config keys`): brain wiring (brain.dir, brain.remote),
# hosted-gateway identity (auth.gatewayUrl, auth.tenantId, auth.org,
# auth.plan), setup provenance (setup.mode, setup.completed_at) and model
# routing (model.default, model.ladder — the operator's declared CLI_MODEL /
# CLI_MODELS preference; an explicit env pin still wins at runtime).
#
# Guardrails carried over from the raw lib (scripts/lib/myai_config.sh):
#   • brain.remote refuses the current code repo's own remote (ADR-016 §0.4 —
#     a brain nested on a shared code remote would publish private memory).
#   • Writes are atomic (tmp + rename) and always stamp version:1.
#   • Redaction: values of secret-named keys print as <redacted>; a password
#     embedded in any URL value (scheme://user:pass@host) prints as user:***@.
#
# Exit codes: 0 success · 2 usage/validation refusal · 3 key not set (get).
#
# Library mode (unit tests): MYAI_CONFIG_CMD_LIB_ONLY=1 sources the helpers
# (schema_lookup / validate_value / is_secret_name / cmd_*) without running
# main. Hermetic under MYAI_HOME=<tmpdir>. bash 3.2-safe (macOS default bash);
# JSON work runs on python3, same as the lib.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
CALLER_PWD="$PWD"

# Raw store primitives (myai_config_home/path/get/set) + the ADR-016 §0.4
# code-remote guardrail (_myai_is_code_remote).
# shellcheck source=lib/myai_config.sh
. "$SCRIPT_DIR/lib/myai_config.sh"

# ── colours (AI_RULES §13: orange = good, yellow = warn, red = bad) ───────────
ORANGE=$'\033[1;38;5;208m'; YELLOW=$'\033[38;5;220m'; RED=$'\033[38;5;196m'
CYAN=$'\033[38;5;45m'; RESET=$'\033[0m'
c_warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1" >&2; }
c_err()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1" >&2; }
c_ok()   { printf '  %s✓%s %s\n' "$ORANGE" "$RESET" "$1" >&2; }

print_help() { grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; }

# ── schema ────────────────────────────────────────────────────────────────────
# One line per known key:  key|type|managed?|description
# `managed` keys are written by myai itself (setup/login) — `set`/`unset`
# refuse them so provenance stamps can't be hand-forged through this front-end.
schema_table() {
    cat <<'EOF'
version|int|managed|config schema version (stamped by every write)
brain.dir|abspath|-|absolute path to the brain repo on this machine
brain.remote|giturl|-|PRIVATE git remote for the brain — never the code repo's own remote (ADR-016 §0.4)
auth.gatewayUrl|url|-|hosted gateway base URL (http:// or https://) — `myai login` validates it live
auth.tenantId|slug|-|tenant id on the hosted gateway (set by `myai login`)
auth.org|string|-|org name for the session identity (set by `myai login`)
auth.plan|enum:free,solo,team,scale|-|plan tier on the hosted gateway
setup.mode|enum:connect,new|managed|how `myai setup` wired the brain (connect an existing one vs provision new)
setup.completed_at|iso8601|managed|when `myai setup` completed (UTC, stamped by the wizard)
model.default|model|-|default model id for autonomous runner sessions (CLI_MODEL preference; an env pin wins)
model.ladder|modellist|-|space-separated model fallback ladder (CLI_MODELS preference; an env pin wins)
EOF
}

# schema_lookup <key> — print the schema line for the key; rc 1 when unknown.
schema_lookup() {
    schema_table | grep -m1 "^$(printf '%s' "$1" | sed 's/[.[\*^$]/\\&/g')|" 2>/dev/null
}

# Secret-shaped key NAMES are never stored (or printed) by this front-end —
# mirrors bin/myai.cjs SECRET_KEY_RE in spirit. Exported so the python render
# path applies the exact same test (single source of truth per run).
SECRET_NAME_RE='secret|password|passwd|token|credential|apikey|api[._-]?key|(^|[._-])key([._-]|$)'
export SECRET_NAME_RE
is_secret_name() { printf '%s' "$1" | LC_ALL=C grep -Eiq "$SECRET_NAME_RE"; }

# validate_value <type> <value> — rc 0 valid; rc 1 with the expected format on
# stdout (the caller wraps it into the refusal message).
validate_value() {
    local type="$1" value="$2" pat m
    case "$type" in
        int)      pat='^[0-9]+$';                          m='an integer' ;;
        string)   pat='^..*$';                             m='a non-empty string' ;;
        slug)     pat='^[A-Za-z0-9][A-Za-z0-9._-]*$';      m='a slug ([A-Za-z0-9._-], starting alphanumeric)' ;;
        abspath)  pat='^/.';                               m='an absolute path (starting with /)' ;;
        url)      pat='^https?://[^[:space:]]+$';          m='an http:// or https:// URL (no spaces)' ;;
        model)    pat='^[A-Za-z0-9][A-Za-z0-9._:-]*$';     m='a model id ([A-Za-z0-9._:-], starting alphanumeric)' ;;
        iso8601)  pat='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; m='a UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)' ;;
        giturl)
            # ssh (git@host:path), http(s), or a local absolute path — the one
            # hard rule is no whitespace (a pasted multi-word value is always a
            # mistake). The code-remote guardrail runs separately in cmd_set.
            pat='^[^[:space:]]+$'; m='a git remote URL (ssh/https/absolute path, no spaces)' ;;
        modellist)
            local one ok=0
            for one in $value; do
                printf '%s' "$one" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:-]*$' || ok=1
            done
            [ -n "$value" ] && [ "$ok" = 0 ] && return 0
            printf '%s' 'space-separated model ids ([A-Za-z0-9._:-] each)'; return 1 ;;
        enum:*)
            local allowed="${type#enum:}" IFS=','
            for one in $allowed; do [ "$value" = "$one" ] && return 0; done
            printf 'one of: %s' "$allowed" | tr ',' '|'; return 1 ;;
        *)  printf 'unknown schema type %s' "$type"; return 1 ;;
    esac
    printf '%s' "$value" | LC_ALL=C grep -Eq "$pat" && return 0
    printf '%s' "$m"; return 1
}

# ── render helpers (python3 — same dependency the lib already requires) ───────

# _py_render list|get — reads the config JSON and prints redacted output.
#   list: env MYAI_CFG_JSON/REVEAL/SCHEMA_KEYS → human table or JSON
#   get:  argv[2] = key → raw (redacted) scalar; rc 3 when missing
_py_render() {
    python3 - "$@" <<'PY'
import json, os, re, sys

mode = sys.argv[1]
path = os.environ["MYAI_CFG_FILE"]
reveal = os.environ.get("MYAI_CFG_REVEAL") == "1"
as_json = os.environ.get("MYAI_CFG_JSON") == "1"
secret_re = re.compile(os.environ["SECRET_NAME_RE"], re.I)
schema_keys = set(os.environ.get("MYAI_CFG_SCHEMA_KEYS", "").split())

def load():
    try:
        with open(path) as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}

def flatten(d, prefix=""):
    for k in sorted(d):
        key = f"{prefix}{k}"
        if isinstance(d[k], dict):
            yield from flatten(d[k], key + ".")
        else:
            yield key, d[k]

# Redact a password embedded in any URL-shaped value: scheme://user:pass@host
URL_CRED = re.compile(r"(\w+://[^/@\s:]+):[^/@\s]+@")

def redact(key, value):
    if reveal:
        return value
    if secret_re.search(key):
        return "<redacted>"
    if isinstance(value, str):
        return URL_CRED.sub(r"\1:***@", value)
    return value

data = load()

if mode == "get":
    key = sys.argv[2]
    cur = data
    for part in key.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            sys.exit(3)
    if isinstance(cur, dict):
        sys.exit(3)
    out = redact(key, cur)
    if as_json:
        print(json.dumps({"key": key, "value": out,
                          "known": key in schema_keys,
                          "redacted": out != cur}))
    else:
        print(out)
    sys.exit(0)

entries = [{"key": k, "value": redact(k, v), "known": k in schema_keys,
            "secret": bool(secret_re.search(k))} for k, v in flatten(data)]
unknown = [e for e in entries if not e["known"]]
if as_json:
    print(json.dumps({"path": path, "entries": entries,
                      "unknown": len(unknown)}, indent=2))
    sys.exit(0)
if not entries:
    print(f"myai config — {path} (empty — nothing set yet)")
    sys.exit(0)
width = max(len(e["key"]) for e in entries)
print(f"myai config — {path}\n")
for e in entries:
    mark = "" if e["known"] else "   ! unknown key (not in the myai schema)"
    print(f"  {e['key']:<{width}} = {e['value']}{mark}")
if unknown:
    n = len(unknown)
    sys.stdout.flush()  # keep the stderr note AFTER the table when both hit a tty/pipe
    print(f"\n  ! {n} unknown key{'s' if n > 1 else ''} — not consumed by any "
          f"myai command; `myai config unset <key>` to clean up", file=sys.stderr)
PY
}

# _py_unset <key> — delete a leaf (pruning empty parents). rc 0 removed,
# rc 3 when the key was not set (nothing to do).
_py_unset() {
    python3 - "$MYAI_CFG_FILE" "$1" <<'PY'
import json, os, sys
path, key = sys.argv[1], sys.argv[2]
try:
    with open(path) as fh:
        d = json.load(fh)
    if not isinstance(d, dict):
        d = {}
except Exception:
    d = {}
parts = key.split(".")
chain, cur = [], d
for p in parts[:-1]:
    if not isinstance(cur.get(p), dict):
        sys.exit(3)
    chain.append((cur, p))
    cur = cur[p]
if parts[-1] not in cur:
    sys.exit(3)
del cur[parts[-1]]
for parent, name in reversed(chain):
    if not parent[name]:
        del parent[name]
tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(d, fh, indent=2)
    fh.write("\n")
os.replace(tmp, path)
PY
}

# ── subcommands ───────────────────────────────────────────────────────────────

# valid_key_shape <key> — dotted segments, each [A-Za-z_][A-Za-z0-9_-]*.
valid_key_shape() {
    printf '%s' "$1" | LC_ALL=C grep -Eq '^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$'
}

# Suggest the closest schema key for a typo'd one (difflib; best-effort).
suggest_key() {
    schema_table | cut -d'|' -f1 | python3 -c '
import difflib, sys
target = sys.argv[1]
m = difflib.get_close_matches(target, [l.strip() for l in sys.stdin], n=1, cutoff=0.6)
print(m[0] if m else "")' "$1" 2>/dev/null
}

cmd_list() {
    local reveal=0 as_json=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --reveal) reveal=1 ;;
            --json)   as_json=1 ;;
            *) c_err "unknown flag for list: $1"; return 2 ;;
        esac; shift
    done
    MYAI_CFG_FILE="$(myai_config_path)" MYAI_CFG_REVEAL="$reveal" MYAI_CFG_JSON="$as_json" \
    MYAI_CFG_SCHEMA_KEYS="$(schema_table | cut -d'|' -f1 | tr '\n' ' ')" \
        _py_render list
}

cmd_keys() {
    local as_json=0
    [ "${1:-}" = "--json" ] && as_json=1
    if [ "$as_json" = 1 ]; then
        schema_table | python3 -c '
import json, sys
rows = []
for line in sys.stdin:
    key, type_, managed, desc = line.rstrip("\n").split("|", 3)
    rows.append({"key": key, "type": type_, "managed": managed == "managed", "desc": desc})
print(json.dumps(rows, indent=2))'
        return 0
    fi
    printf 'myai config — known keys (the schema)\n\n'
    local line key type managed desc
    while IFS='|' read -r key type managed desc; do
        printf '  %-20s %-28s %s%s\n' "$key" "($type)" "$desc" \
            "$([ "$managed" = managed ] && printf ' %s[managed — read-only here]%s' "$CYAN" "$RESET")"
    done < <(schema_table)
}

cmd_get() {
    local key="" reveal=0 as_json=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --reveal) reveal=1 ;;
            --json)   as_json=1 ;;
            -*) c_err "unknown flag for get: $1"; return 2 ;;
            *)  [ -z "$key" ] && key="$1" || { c_err "unexpected argument: $1"; return 2; } ;;
        esac; shift
    done
    [ -n "$key" ] || { c_err "usage: myai config get <key>"; return 2; }
    valid_key_shape "$key" || { c_err "malformed key '$key' (dotted segments, [A-Za-z0-9_-])"; return 2; }
    schema_lookup "$key" >/dev/null || c_warn "'$key' is not in the myai schema (see \`myai config keys\`)"
    local rc=0
    MYAI_CFG_FILE="$(myai_config_path)" MYAI_CFG_REVEAL="$reveal" MYAI_CFG_JSON="$as_json" \
    MYAI_CFG_SCHEMA_KEYS="$(schema_table | cut -d'|' -f1 | tr '\n' ' ')" \
        _py_render get "$key" || rc=$?
    [ "$rc" = 3 ] && c_warn "'$key' is not set"
    return "$rc"
}

cmd_set() {
    local key="" value="" force=0 have_value=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --force) force=1 ;;
            -*) c_err "unknown flag for set: $1"; return 2 ;;
            *)  if [ -z "$key" ]; then key="$1"
                elif [ "$have_value" = 0 ]; then value="$1"; have_value=1
                else c_err "unexpected argument: $1"; return 2; fi ;;
        esac; shift
    done
    { [ -n "$key" ] && [ "$have_value" = 1 ]; } || { c_err "usage: myai config set <key> <value>"; return 2; }
    valid_key_shape "$key" || { c_err "malformed key '$key' (dotted segments, [A-Za-z0-9_-])"; return 2; }

    # Secret-named keys NEVER go into config — even with --force. The store is
    # non-secret by design (myai_login.sh keeps raw keys in ~/.myai/credentials).
    if is_secret_name "$key"; then
        c_err "'$key' looks like a credential — config never stores secrets"
        c_warn "use \`myai login\` (hosted key → ~/.myai/credentials) or \`myai rotate-keys\` instead"
        return 2
    fi

    local line
    if ! line="$(schema_lookup "$key")"; then
        if [ "$force" = 1 ]; then
            c_warn "'$key' is not in the myai schema — writing anyway (--force); no myai command consumes it"
        else
            local hint; hint="$(suggest_key "$key")"
            c_err "unknown key '$key' — refusing to write (see \`myai config keys\`)"
            [ -n "$hint" ] && c_warn "did you mean '$hint'?"
            c_warn "pass --force to write it anyway"
            return 2
        fi
    else
        local type managed
        type="$(printf '%s' "$line" | cut -d'|' -f2)"
        managed="$(printf '%s' "$line" | cut -d'|' -f3)"
        if [ "$managed" = "managed" ]; then
            c_err "'$key' is managed by myai (setup/login stamps it) — not settable here"
            return 2
        fi
        local expected
        if ! expected="$(validate_value "$type" "$value")"; then
            c_err "invalid value for '$key' — expected $expected"
            return 2
        fi
        # ADR-016 §0.4: the brain remote must never be the code repo's remote.
        if [ "$key" = "brain.remote" ] && _myai_is_code_remote "$CALLER_PWD" "$value"; then
            c_err "that URL is this repo's own code remote — the brain must live in a SEPARATE private repo (ADR-016 §0.4)"
            return 2
        fi
    fi

    myai_config_set "$key" "$value" || { c_err "write failed ($(myai_config_path))"; return 1; }
    local shown
    shown="$(MYAI_CFG_FILE="$(myai_config_path)" MYAI_CFG_REVEAL=0 MYAI_CFG_JSON=0 \
             MYAI_CFG_SCHEMA_KEYS="" _py_render get "$key")" || shown="$value"
    c_ok "set $key = $shown"
}

cmd_unset() {
    local key="${1:-}"
    [ -n "$key" ] || { c_err "usage: myai config unset <key>"; return 2; }
    [ $# -le 1 ] || { c_err "unexpected argument: $2"; return 2; }
    valid_key_shape "$key" || { c_err "malformed key '$key' (dotted segments, [A-Za-z0-9_-])"; return 2; }
    local line
    if line="$(schema_lookup "$key")" && [ "$(printf '%s' "$line" | cut -d'|' -f3)" = "managed" ]; then
        c_err "'$key' is managed by myai — not removable here"
        return 2
    fi
    local rc=0
    MYAI_CFG_FILE="$(myai_config_path)" _py_unset "$key" || rc=$?
    if [ "$rc" = 3 ]; then c_warn "'$key' is not set — nothing to do"; return 0; fi
    [ "$rc" = 0 ] && c_ok "unset $key"
    return "$rc"
}

# ── main ──────────────────────────────────────────────────────────────────────
main() {
    local sub="${1:-list}"
    [ $# -gt 0 ] && shift
    case "$sub" in
        -h|--help|help) print_help ;;
        list)  cmd_list "$@" ;;
        keys)  cmd_keys "$@" ;;
        get)   cmd_get "$@" ;;
        set)   cmd_set "$@" ;;
        unset) cmd_unset "$@" ;;
        path)  myai_config_path ;;
        --json|--reveal) cmd_list "$sub" "$@" ;;   # bare `config --json` = list --json
        *) c_err "unknown subcommand '$sub' — one of: list | keys | get | set | unset | path"; return 2 ;;
    esac
}

# Library mode for the unit suite (scripts/tests/test_myai_config_cmd.sh):
# define the helpers, run nothing.
if [ "${MYAI_CONFIG_CMD_LIB_ONLY:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

main "$@"
