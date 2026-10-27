FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Production ──────────────────────────────────
FROM node:24-alpine

WORKDIR /app

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY loopback-gate.js ./loopback-gate.js

ENV PORT=3210
ENV HOSTNAME="0.0.0.0"
# Next's own (unmodified) server.js listens here instead — internal to this
# container only, never published — so loopback-gate.js can be the one thing
# that sees every inbound connection's real peer address. See that file.
ENV NEXT_INTERNAL_PORT=3211

EXPOSE 3210

# Two processes: Next's stock standalone server on the internal port, and the
# loopback-gate front door on the published one. See loopback-gate.js for why.
CMD ["sh", "-c", "PORT=$NEXT_INTERNAL_PORT HOSTNAME=127.0.0.1 node server.js & exec node loopback-gate.js"]
