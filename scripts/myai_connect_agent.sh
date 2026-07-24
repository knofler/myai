#!/usr/bin/env bash
# =============================================================================
# myai_connect_agent.sh — plug ANY agent into the continuity layer.
#
# One command that prints (or installs) MCP client config for the popular
# coding agents, pointing them at the local myAI gateway with the local token,
# then PROVES the hookup with a live round-trip: the agent's first handshake
# (`initialize`) receives the betaC auto-boot bundle, and a `context_boot`
# call answers "who am I working with?" with the operator's context.
#
# Clients:
#   claude     Claude Code            → ./.mcp.json            (project scope)
#   cursor     Cursor                 → ~/.cursor/mcp.json     (global)
#   windsurf   Windsurf               → ~/.codeium/windsurf/mcp_config.json
#   codex      Codex CLI              → ~/.codex/config.toml   (stdio bridge
#              via `npx mcp-remote` — Codex's MCP support is stdio-first)
#
# Usage:
#   myai connect-agent                     # print config for ALL clients + verify
#   myai connect-agent claude              # print just Claude Code's config + verify
#   myai connect-agent claude --install    # write ./.mcp.json + verify
#   myai connect-agent all --install       # install every client + verify
#   myai connect-agent --verify            # verification round-trip only
#   myai connect-agent --no-verify         # print/install without touching the gateway
#
# Install is a MERGE, never a clobber: existing servers in a client's config
# are preserved; only the `myai` entry is added/updated. A config file with
# invalid JSON is refused (nothing is written). Re-running is idempotent.
#
# Why the token header: local clients hit the *published* Docker port
# (localhost:3100), which the gateway sees as the bridge IP — NOT loopback —
# so `x-gateway-local-token` is mandatory (ADR-010 M1; scripts/lib/gateway.sh).
#
# Requires: bash + node >= 20 (fetch built in). No curl/python/jq — this must
# also run inside the node:20-slim CI container.
#
# Env: GATEWAY_MCP (default http://localhost:3100/mcp), GATEWAY_LOCAL_TOKEN
#      (via scripts/lib/gateway.sh). Install-target overrides (mainly for
#      tests): MYAI_CLAUDE_MCP_FILE, MYAI_CURSOR_MCP_FILE,
#      MYAI_WINDSURF_MCP_FILE, MYAI_CODEX_CONFIG_FILE.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATEWAY_MCP=${GATEWAY_MCP:-http://localhost:3100/mcp}
# Local-token escape hatch — gateway enforces auth (ADR-010 M1); host calls aren't loopback.
. "$SCRIPT_DIR/lib/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
export GATEWAY_MCP GATEWAY_LOCAL_TOKEN

ALL_CLIENTS=(claude cursor windsurf codex)

# ── args ──────────────────────────────────────────────────────────────────────
CLIENTS=()
INSTALL=false
VERIFY=true
VERIFY_ONLY=false
while [ $# -gt 0 ]; do
  case "$1" in
    claude|cursor|windsurf|codex) CLIENTS+=("$1") ;;
    all) CLIENTS=("${ALL_CLIENTS[@]}") ;;
    --install)   INSTALL=true ;;
    --no-verify) VERIFY=false ;;
    --verify)    VERIFY_ONLY=true ;;
    -h|--help)   sed -n '2,41p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1 (clients: claude cursor windsurf codex all; see --help)" >&2; exit 2 ;;
  esac
  shift
done
[ ${#CLIENTS[@]} -eq 0 ] && CLIENTS=("${ALL_CLIENTS[@]}")

# ── install targets (env-overridable for tests) ───────────────────────────────
CLAUDE_FILE="${MYAI_CLAUDE_MCP_FILE:-$PWD/.mcp.json}"
CURSOR_FILE="${MYAI_CURSOR_MCP_FILE:-$HOME/.cursor/mcp.json}"
WINDSURF_FILE="${MYAI_WINDSURF_MCP_FILE:-$HOME/.codeium/windsurf/mcp_config.json}"
CODEX_FILE="${MYAI_CODEX_CONFIG_FILE:-$HOME/.codex/config.toml}"

# ── per-client JSON entries (the value under mcpServers.myai) ─────────────────
client_entry() { # $1 = client → prints the JSON entry
  case "$1" in
    claude)   printf '{"type":"http","url":"%s","headers":{"x-gateway-local-token":"%s"}}' "$GATEWAY_MCP" "$GATEWAY_LOCAL_TOKEN" ;;
    cursor)   printf '{"url":"%s","headers":{"x-gateway-local-token":"%s"}}' "$GATEWAY_MCP" "$GATEWAY_LOCAL_TOKEN" ;;
    windsurf) printf '{"serverUrl":"%s","headers":{"x-gateway-local-token":"%s"}}' "$GATEWAY_MCP" "$GATEWAY_LOCAL_TOKEN" ;;
  esac
}

client_file() { # $1 = client → prints the install target path
  case "$1" in
    claude)   printf '%s' "$CLAUDE_FILE" ;;
    cursor)   printf '%s' "$CURSOR_FILE" ;;
    windsurf) printf '%s' "$WINDSURF_FILE" ;;
    codex)    printf '%s' "$CODEX_FILE" ;;
  esac
}

client_label() { # $1 = client → human name
  case "$1" in
    claude)   printf 'Claude Code' ;;
    cursor)   printf 'Cursor' ;;
    windsurf) printf 'Windsurf' ;;
    codex)    printf 'Codex CLI' ;;
  esac
}

# ── print mode ────────────────────────────────────────────────────────────────
print_client() { # $1 = client
  local label file
  label="$(client_label "$1")"
  file="$(client_file "$1")"
  echo "── $label — $file"
  if [ "$1" = codex ]; then
    # TOML; Codex speaks stdio MCP → bridge HTTP via mcp-remote.
    cat <<EOF
[mcp_servers.myai]
command = "npx"
args = ["-y", "mcp-remote", "$GATEWAY_MCP", "--header", "x-gateway-local-token:$GATEWAY_LOCAL_TOKEN"]
EOF
  else
    node -e '
      const [key, entry] = process.argv.slice(1);
      console.log(JSON.stringify({ mcpServers: { [key]: JSON.parse(entry) } }, null, 2));
    ' myai "$(client_entry "$1")"
  fi
  echo
}

# ── install mode ──────────────────────────────────────────────────────────────
install_json() { # $1 = client (claude|cursor|windsurf) — merge mcpServers.myai
  local file entry
  file="$(client_file "$1")"
  entry="$(client_entry "$1")"
  node -e '
    const fs = require("fs"), path = require("path");
    const [file, entryJson] = process.argv.slice(1);
    let cfg = {};
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      if (raw.trim()) {
        try { cfg = JSON.parse(raw); }
        catch (e) { console.error(`  ✗ refusing to touch ${file} — existing content is not valid JSON (${e.message})`); process.exit(1); }
      }
    }
    if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) cfg = {};
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers.myai = JSON.parse(entryJson);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  ' "$file" "$entry"
}

install_codex() { # upsert the [mcp_servers.myai] TOML block
  node -e '
    const fs = require("fs"), path = require("path");
    const [file, url, token] = process.argv.slice(1);
    const block = [
      "[mcp_servers.myai]",
      `command = "npx"`,
      `args = ["-y", "mcp-remote", "${url}", "--header", "x-gateway-local-token:${token}"]`,
      "",
    ].join("\n");
    let txt = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const lines = txt.length ? txt.split("\n") : [];
    const start = lines.findIndex((l) => l.trim() === "[mcp_servers.myai]");
    if (start >= 0) {
      // Replace from the header to the next table header (or EOF).
      let end = start + 1;
      while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
      lines.splice(start, end - start, ...block.split("\n"));
      txt = lines.join("\n");
      if (!txt.endsWith("\n")) txt += "\n";
    } else {
      txt = txt.trimEnd();
      txt = (txt ? txt + "\n\n" : "") + block;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, txt);
  ' "$CODEX_FILE" "$GATEWAY_MCP" "$GATEWAY_LOCAL_TOKEN"
}

install_client() { # $1 = client
  if [ "$1" = codex ]; then install_codex; else install_json "$1"; fi
  echo "  ✓ $(client_label "$1") — myai server written to $(client_file "$1")"
}

# ── verify: initialize (betaC auto-boot) + context_boot round-trip ────────────
verify_connection() {
  echo "── verify — $GATEWAY_MCP"
  node -e '
    const url = process.env.GATEWAY_MCP;
    const headers = {
      "content-type": "application/json",
      "x-gateway-local-token": process.env.GATEWAY_LOCAL_TOKEN || "",
    };
    const rpc = async (method, params) => {
      const r = await fetch(url, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!r.ok) throw new Error(`gateway HTTP ${r.status} on ${method}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
      return d.result;
    };
    (async () => {
      // 1. The handshake every MCP client performs on connect. betaC auto-boot
      //    rides in on `instructions` — cooperating clients get the operator
      //    context before the first user message.
      const init = await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "myai-connect-agent", version: "1.0.0" },
      });
      const name = init?.serverInfo?.name || "(unknown)";
      console.log(`  ✓ initialize — connected to ${name} v${init?.serverInfo?.version || "?"}`);
      if (init?.instructions) {
        console.log(`  ✓ betaC auto-boot — ${init.instructions.length} chars of operator context injected on handshake`);
      } else {
        console.log("  ! betaC auto-boot — no instructions in InitializeResult (bundle disabled or empty; context_boot still works)");
      }

      // 2. The callable form: a blank agent asks "who am I working with?".
      const call = await rpc("tools/call", {
        name: "context_boot",
        arguments: {},
      });
      const text = call?.content?.[0]?.text ?? "";
      let boot;
      try { boot = JSON.parse(text); } catch { throw new Error("context_boot returned non-JSON payload"); }
      if (boot?.error) throw new Error(`context_boot: ${boot.error}`);
      if (!boot?.bundle) throw new Error("context_boot returned no bundle");
      console.log(`  ✓ context_boot — boot bundle OK (~${boot.tokenEstimate ?? "?"} tokens, project: ${boot.parts?.activeProject ?? "?"})`);
      console.log("");
      console.log("  What a blank agent learns the moment it connects:");
      const cap = (s) => { s = String(s).replace(/\s+/g, " ").trim(); return s.length > 120 ? s.slice(0, 119) + "…" : s; };
      if (boot.brief?.who) {
        // Structured operator brief (who / state / handoff / next).
        console.log(`  │ Who:     ${cap(boot.brief.who)}`);
        console.log(`  │ State:   ${cap(boot.brief.state ?? "")}`);
        if (boot.brief.handoff) console.log(`  │ Handoff: ${cap(boot.brief.handoff)}`);
        if (boot.brief.next)    console.log(`  │ Next:    ${cap(boot.brief.next)}`);
      } else {
        // Older gateway: no structured brief — preview the rendered bundle.
        const preview = String(boot.bundle).split("\n").slice(0, 14);
        for (const line of preview) console.log(`  │ ${line}`);
        if (String(boot.bundle).split("\n").length > 14) console.log("  │ …");
      }
      process.exit(0);
    })().catch((e) => {
      console.error(`  ✗ ${e.message}`);
      console.error("    Is the stack up? Try: myai up   (then re-run: myai connect-agent --verify)");
      process.exit(1);
    });
  '
}

# ── main ──────────────────────────────────────────────────────────────────────
if $VERIFY_ONLY; then
  verify_connection
  exit $?
fi

if $INSTALL; then
  echo "== myai connect-agent — installing MCP config =="
  for c in "${CLIENTS[@]}"; do install_client "$c"; done
  echo
else
  echo "== myai connect-agent — MCP config (add with --install, or copy-paste) =="
  echo
  for c in "${CLIENTS[@]}"; do print_client "$c"; done
fi

if $VERIFY; then
  verify_connection || exit 1
  echo
  echo "Connected. Restart the client (or /mcp reconnect) and it already knows you."
else
  echo "Verification skipped (--no-verify). When the stack is up: myai connect-agent --verify"
fi
