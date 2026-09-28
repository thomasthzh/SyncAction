FROM node:22.20.0-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server ./apps/server
COPY apps/superadmin ./apps/superadmin
COPY packages ./packages

RUN pnpm install --frozen-lockfile --prod \
    --filter @syncaction/server... \
    --filter @syncaction/superadmin...

ENV NODE_ENV=production

USER node

STOPSIGNAL SIGTERM
