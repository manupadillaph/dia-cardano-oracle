# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Stage 1 — build CLI: compile TypeScript → JavaScript
# ---------------------------------------------------------------------------
FROM node:22-alpine AS cli-build
WORKDIR /build/cli

# Build tools needed by better-sqlite3 / lucid-evolution native deps.
RUN apk add --no-cache python3 make g++

COPY cli/package.json cli/package-lock.json* ./
RUN npm ci --ignore-scripts

COPY cli/tsconfig.json ./
COPY cli/src ./src
RUN npm run build

# Prune dev deps for the runtime stage.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2 — build feeder
# ---------------------------------------------------------------------------
FROM node:22-alpine AS feeder-build
WORKDIR /build/feeder

RUN apk add --no-cache python3 make g++

COPY feeder/package.json feeder/package-lock.json* ./
RUN npm ci --ignore-scripts

COPY feeder/tsconfig.json ./
COPY feeder/cmd ./cmd
COPY feeder/src ./src
RUN npm run build

RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 3 — runtime: feeder + CLI in one lean image
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# Feeder artefacts.
COPY --from=feeder-build /build/feeder/package.json /app/feeder/package.json
COPY --from=feeder-build /build/feeder/node_modules /app/feeder/node_modules
COPY --from=feeder-build /build/feeder/dist /app/feeder/dist

# CLI artefacts.
COPY --from=cli-build /build/cli/package.json /app/cli/package.json
COPY --from=cli-build /build/cli/node_modules /app/cli/node_modules
COPY --from=cli-build /build/cli/dist /app/cli/dist

# Convenience wrapper for operators: `dia-cli <command>` from any shell.
RUN printf '#!/bin/sh\nexec node /app/cli/dist/index.js "$@"\n' > /usr/local/bin/dia-cli \
    && chmod +x /usr/local/bin/dia-cli

# Mount points for config and on-chain artefacts (see volume layout in README).
RUN mkdir -p /config /state /artifacts \
    && chown -R node:node /config /state /artifacts

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/health/live || exit 1

USER node

# CLI module root for the lib-bridge dynamic imports. Set here so the feeder
# inside the container resolves compiled CLI dist instead of the dev src tree.
# Key: CARDANO_FEEDER_CLI_DIST_ROOT (documented in .env.example).
ENV CARDANO_FEEDER_CLI_DIST_ROOT=/app/cli/dist

# Default: feeder daemon. Override `command:` in compose to invoke CLI.
# ENTRYPOINT is intentionally absent so each service specifies its own binary.
CMD ["node", "/app/feeder/dist/cmd/feeder/main.js", "--config", "/config"]
