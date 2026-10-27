#!/usr/bin/env bash
# peek.sh — alias of check_session.sh (`peek <target>` == `check <target>`).
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/check_session.sh" "$@"
