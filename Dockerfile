# syntax=docker/dockerfile:1.7
# One image, two processes (DEPLOYMENT.md §3):
#   web:    node server.js
#   worker: node dist/worker.mjs
FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build && pnpm build:node

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd --system vault && useradd --system --gid vault --home /app vault
# Web (Next.js standalone output)
COPY --from=build --chown=vault:vault /app/.next/standalone ./
COPY --from=build --chown=vault:vault /app/.next/static ./.next/static
# Worker bundle + production dependencies + migrations
COPY --from=build --chown=vault:vault /app/dist ./dist
COPY --from=prod-deps --chown=vault:vault /app/node_modules ./node_modules
COPY --from=build --chown=vault:vault /app/drizzle ./drizzle
COPY --from=build --chown=vault:vault /app/package.json ./package.json
USER vault
EXPOSE 3000
CMD ["node", "server.js"]
