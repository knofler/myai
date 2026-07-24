#!/usr/bin/env bash
# secret_patterns.sh — SINGLE SOURCE OF TRUTH for the fleet's secret-scan regexes.
#
# Consumers:
#   hooks/pre-tool/03-secret-scan.sh   blocks `git commit` when a staged diff matches
#   scripts/myai_memory.sh             redacts matches from exported memory bundles
#
# Pattern fragments are concatenated at runtime so this file never contains a
# literal string that matches its own regexes — earlier hook versions
# self-matched during propagation commits (the PEM regex, with `.` wildcards,
# matched its own source text in the staged diff). Keep the concatenation
# trick when adding patterns.
#
# Layout note: lives at <root>/scripts/lib/ (master) or <root>/AI/scripts/lib/
# (managed) — consumers resolve it relative to themselves, same as gateway.sh.

# Token-shaped credentials (safe to redact in place — each match IS the secret).
SECRET_PAT_AWS='AKIA[A-Z0-9]{16}'
SECRET_PAT_OPENAI='sk-[a-zA-Z0-9]{48}'
SECRET_PAT_GH='ghp_[a-zA-Z0-9]{36}'
SECRET_PAT_GCP='AIza[a-zA-Z0-9_-]{35}'
# myAI per-tenant API key (ADR-010 §3.6) — myai_live_/myai_test_ + base62 secret.
SECRET_PAT_MYAI="myai_(live|test)_[A-Za-z0-9]""{20,}"

# PEM header — the DETECTION pattern for private-key material. Redaction must
# remove the WHOLE block (see secret_redact_file), not just this header line.
SECRET_PAT_PEM='-----BEGIN [A-Z ]+KEY-----'

# Combined detection regex — what hook 03 greps staged diffs with.
SECRET_PAT_COMBINED="${SECRET_PAT_AWS}|${SECRET_PAT_OPENAI}|${SECRET_PAT_GH}|${SECRET_PAT_GCP}|${SECRET_PAT_PEM}|${SECRET_PAT_MYAI}"

# secret_scan_file <file> — exit 0 (and print matching lines) if the file
# contains secret material, exit 1 if clean. Case-insensitive, same as hook 03.
secret_scan_file() {
  grep -iE "$SECRET_PAT_COMBINED" "$1" 2>/dev/null
}

# secret_redact_file <file> — replace every secret in the file, in place:
#   token credentials → [REDACTED-SECRET]
#   whole PEM blocks (BEGIN…END, body included) → [REDACTED-PRIVATE-KEY]
# Prints the number of redactions made. perl ships on macOS + Linux and handles
# the multi-line PEM block where sed can't (portably).
secret_redact_file() {
  local f="$1"
  local pem_begin pem_end
  pem_begin='-----BEGIN [A-Z ]+KEY'"-----"
  pem_end='-----END [A-Z ]+KEY'"-----"
  perl -0777 -i -pe '
    my $n = 0;
    $n += s/'"$pem_begin"'.*?'"$pem_end"'/[REDACTED-PRIVATE-KEY]/gs;
    $n += s/'"$SECRET_PAT_AWS"'|'"$SECRET_PAT_OPENAI"'|'"$SECRET_PAT_GH"'|'"$SECRET_PAT_GCP"'|'"$SECRET_PAT_MYAI"'/[REDACTED-SECRET]/g;
    print STDERR "$n\n" if eof;
  ' "$f" 2>&1 | tail -1
}
