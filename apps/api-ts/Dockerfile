# syntax=docker/dockerfile:1

# ---- base: Node + all dependencies (also used by the test service) ----
FROM node:24-alpine AS base
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- app: production image for api / worker / scheduler ----
FROM base AS app
COPY . .
RUN pnpm build \
 && pnpm prune --prod \
 && mkdir -p /app/storage/images/uploads /app/storage/images/results \
 && chown -R node:node /app/storage
ENV TZ=UTC NODE_ENV=production
USER node
CMD ["node", "dist/server.js"]
