# syntax=docker/dockerfile:1.7
# Build from the repository root:  docker build -f apps/api/Dockerfile -t agentbazaar-api .
FROM node:24-alpine AS base
RUN npm install -g pnpm@12.16.1 && apk add --no-cache wget
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@agentbazaar/api..." build \
 && rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --filter "@agentbazaar/api..."

# Checkout saga worker (scale, WORKFLOW_ENGINE=temporal). Temporal's native worker core ships glibc
# builds only, so it runs on Debian slim:  docker build -f apps/api/Dockerfile --target workflow-worker .
FROM node:24-bookworm-slim AS workflow-worker
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/migrations ./apps/api/migrations
WORKDIR /repo/apps/api
USER node
CMD ["node", "dist/cli/index.js", "workflow-worker"]

# The API (default target).
FROM node:24-alpine AS runtime
RUN apk add --no-cache wget tini
ENV NODE_ENV=production PORT=4000 HOST=0.0.0.0
WORKDIR /repo
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/migrations ./apps/api/migrations
WORKDIR /repo/apps/api
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
