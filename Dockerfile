# EXOTIC BOT — single image for both the API and worker containers.
# Build context is the repo root (see docker-compose.yml).

# ── build stage ────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund

COPY . .
# Production schema is PostgreSQL — swap the Prisma provider, generate, build.
RUN cp server/prisma/schema.postgres.prisma server/prisma/schema.prisma \
 && npm run db:generate -w server \
 && npm run build -w server \
 && npm run build -w web

# ── runtime stage ──────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/prisma ./server/prisma
COPY --from=build /app/web/dist ./web/dist

# Uploads live outside the container layers (bind-mounted volume in compose)
RUN mkdir -p /app/server/uploads/thumbs /app/server/uploads/audio

WORKDIR /app/server
EXPOSE 4000

# Sync the Postgres schema (idempotent) then boot API + WebSocket + workers.
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
