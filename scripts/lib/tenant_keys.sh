#!/usr/bin/env bash
# tenant_keys.sh — sourceable helper: resolve per-tenant runner API keys.
#
# The off-hours CLI runner (ADR-010 M4) serves *a tenant's* queued tasks by
# authenticating to the gateway with that tenant's per-tenant API key — so the
# gateway derives `tenantId` server-side from the credential (never from a tool
# arg) and scopes task pickup + the review flip to that tenant.
#
# Keys live OUTSIDE git in a local file (default ~/.ai-cli-runner/tenant-keys.env,
# override with $TENANT_KEYS_FILE). One tenant per line:
#
#     <tenantId>=<rawApiKey>        # e.g. acme=myai_live_AbC...   (preferred)
#     <tenantId>:<rawApiKey>        # ':' separator also accepted
#     default=                      # empty key → served over the loopback
#                                   #   default-trust path (single-operator)
#
# Blank lines and lines starting with '#' are ignored; surrounding whitespace is
# trimmed. An empty key is a VALID value (the local default tenant resolves over
# loopback with no key) — distinct from "tenant not present" (lookup returns 1).
#
# bash 3.2-safe (no associative arrays, no mapfile). Pure parameter expansion.
# Functions print to stdout; no global state mutated. Safe to source repeatedly.

# Resolve the keys-file path ($TENANT_KEYS_FILE wins; else the per-machine default).
tk_resolve_file() {
    printf '%s' "${TENANT_KEYS_FILE:-$HOME/.ai-cli-runner/tenant-keys.env}"
}

# Emit "id<TAB>key" for every valid line in the keys file (file order).
# No file → no output, rc 0 (an absent file just means "no extra tenants").
tk_each() {
    local file="${1:-$(tk_resolve_file)}"
    [ -f "$file" ] || return 0
    local line id key
    while IFS= read -r line || [ -n "$line" ]; do
        # trim leading/trailing whitespace
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"
        case "$line" in ''|\#*) continue ;; esac
        # split on the first '=' (preferred) else the first ':'
        if [ "${line%%=*}" != "$line" ]; then
            id="${line%%=*}"; key="${line#*=}"
        elif [ "${line%%:*}" != "$line" ]; then
            id="${line%%:*}"; key="${line#*:}"
        else
            id="$line"; key=""
        fi
        id="${id#"${id%%[![:space:]]*}"}";  id="${id%"${id##*[![:space:]]}"}"
        key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
        [ -z "$id" ] && continue
        printf '%s\t%s\n' "$id" "$key"
    done < "$file"
}

# tk_lookup <tenantId> [file] — print that tenant's key (may be empty), rc 0 if
# the tenant line exists, rc 1 if it is absent. An empty key prints nothing but
# still returns 0, so callers can distinguish "default tenant, no key" from
# "unknown tenant".
tk_lookup() {
    local want="$1" file="${2:-}"
    local id key TAB
    TAB="$(printf '\t')"
    while IFS="$TAB" read -r id key; do
        if [ "$id" = "$want" ]; then printf '%s' "$key"; return 0; fi
    done <<EOF
$(tk_each "$file")
EOF
    return 1
}

# tk_list_tenants [file] — print each configured tenantId, one per line.
tk_list_tenants() {
    local id key TAB
    TAB="$(printf '\t')"
    tk_each "${1:-}" | while IFS="$TAB" read -r id key; do printf '%s\n' "$id"; done
}
