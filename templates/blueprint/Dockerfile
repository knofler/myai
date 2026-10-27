# syntax=docker/dockerfile:1
# Multi-stage build — deps install INSIDE the image (host never runs npm install).
#
# Verify `npm run build` via `./AI/scripts/local-ci.sh` (which runs
# `docker build --target build` — this Dockerfile, unconstrained, exactly
# what CI/Vercel/Render do) or a plain `docker build --target build .`, NOT
# by running `npm run build` interactively inside the running `dev`
# docker-compose container (`docker compose exec app npm run build` / `./dev
# shell` + `npm run build`). Confirmed during the 2026-09-10 Next 16 upgrade:
# the same repo + lockfile + Node version builds clean every time via
# `docker build --target build` (bind-mount-free — Node 22 AND Node 24 both
# verified good), but crashes intermittently via the bind-mounted dev
# container with `TypeError: Cannot read properties of null (reading
# 'useContext')` while prerendering "/" / "/_global-error" — a Turbopack +
# Docker Desktop bind-mount/anonymous-volume interaction, not a Next.js,
# React, or Node version bug (ruled out one variable at a time: Sentry,
# metadata, proxy.ts, React 19.2 vs 19.3, Node 22 vs 24 — all held constant
# while only the build mechanism changed). `./dev build` rebuilds images; it
# does not run `npm run build` inside the running container.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund || npm install --legacy-peer-deps --no-audit --no-fund

# ── Dev target — used by docker-compose for local development ──
FROM node:24-bookworm-slim AS dev
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ── Build target — produces the production .next output ──
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Runtime target — minimal production image ──
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["npm", "run", "start"]
