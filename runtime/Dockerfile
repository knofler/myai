FROM node:20-slim AS builder

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
COPY bin/ ./bin/
COPY gateway.config.json ./

RUN npx tsc

# ── Production ──────────────────────────────────

FROM node:20-slim

# git: the brain_* MCP tools (core/brain.ts, distill.ts, team-brain.ts) shell out
# to git against the bind-mounted ~/.myai/brain repo — without it every brain tool
# is dead in the container even though it registers in tools/list.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/gateway.config.json ./

EXPOSE 3100 3200 3201

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://localhost:3200/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/core/index.js"]
