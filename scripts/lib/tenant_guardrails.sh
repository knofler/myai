#!/usr/bin/env bash
# tenant_guardrails.sh — sourceable helper: resolve per-tenant runner guardrail
# config (budget, model routing, hooks) for GRAND_PRODUCT_ROADMAP §3.3
# execution-isolation (risk #3: multi-tenant data isolation breach).
#
# NOT a secrets file (no API keys here — see tenant_keys.sh for those). Tracked
# in git like runner_budget.conf, because it's operational policy, not a credential.
#
# One line per tenant in config/tenant_guardrails.conf (override with
# $TENANT_GUARDRAILS_FILE):
#
#     <tenantId>: field=value;field=value;...
#
# Supported fields — ALL optional; an absent field/tenant means "use the
# runner's normal default", so a tenant with no line here behaves exactly like
# the pre-existing default-tenant path (backwards compatible):
#     maxMinutes=<int>        per-task wall-clock cap   (overrides MAX_MINUTES)
#     maxRamMb=<int>          per-task RAM cap in MB    (overrides MAX_TASK_RAM_MB)
#     maxCpuPct=<int>         per-task sustained CPU %  (overrides MAX_TASK_CPU_PCT)
#     models="<m1> <m2> ..."  space-separated model chain (overrides CLI_MODELS)
#     hookPre=<path>          script run best-effort in the isolated workspace
#                             BEFORE the session (repo-relative or absolute)
#     hookPost=<path>         same, AFTER the session (always, success or failure)
#
# Blank lines / '#' comments ignored; unknown fields ignored (forward-compat).
# bash 3.2-safe — no associative arrays, no mapfile, pure parameter expansion.

# tg_resolve_file — $TENANT_GUARDRAILS_FILE wins; else config/tenant_guardrails.conf
# next to this lib's repo root.
tg_resolve_file() {
    if [ -n "${TENANT_GUARDRAILS_FILE:-}" ]; then
        printf '%s' "$TENANT_GUARDRAILS_FILE"
        return 0
    fi
    local root
    root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." 2>/dev/null && pwd)"
    printf '%s/config/tenant_guardrails.conf' "${root:-.}"
}

# tg_lookup_field <tenantId> <field> [file] — print the field's raw value (may
# be empty); rc 0 when the tenant line exists (field present or not), rc 1 when
# the tenant has no line at all (or the file is missing). Trailing fields win on
# duplicate keys within a tenant's line (last one wins), same "last occurrence"
# convention as the account-limit-reset parser elsewhere in this runner.
tg_lookup_field() {
    local want="$1" field="$2" file="${3:-$(tg_resolve_file)}"
    [ -f "$file" ] || return 1
    local line id rest kv k v found_tenant=1 val=""
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
        case "$line" in ''|\#*) continue ;; esac
        case "$line" in *:*) : ;; *) continue ;; esac   # a tenant line must have "id: fields"
        id="${line%%:*}"; rest="${line#*:}"
        id="${id#"${id%%[![:space:]]*}"}"; id="${id%"${id##*[![:space:]]}"}"
        [ "$id" = "$want" ] || continue
        found_tenant=0
        rest="${rest#"${rest%%[![:space:]]*}"}"
        while [ -n "$rest" ]; do
            case "$rest" in
                *\;*) kv="${rest%%;*}"; rest="${rest#*;}" ;;
                *)    kv="$rest"; rest="" ;;
            esac
            kv="${kv#"${kv%%[![:space:]]*}"}"; kv="${kv%"${kv##*[![:space:]]}"}"
            [ -z "$kv" ] && continue
            k="${kv%%=*}"; v="${kv#*=}"
            case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; esac
            [ "$k" = "$field" ] && val="$v"
        done
    done < "$file"
    [ "$found_tenant" -eq 0 ] || return 1
    printf '%s' "$val"
    return 0
}

# tg_list_tenants [file] — print each tenant id that has a guardrail line, one per line.
tg_list_tenants() {
    local file="${1:-$(tg_resolve_file)}" line id
    [ -f "$file" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
        case "$line" in ''|\#*) continue ;; esac
        case "$line" in *:*) : ;; *) continue ;; esac
        id="${line%%:*}"; id="${id#"${id%%[![:space:]]*}"}"; id="${id%"${id##*[![:space:]]}"}"
        [ -n "$id" ] && printf '%s\n' "$id"
    done < "$file"
}
