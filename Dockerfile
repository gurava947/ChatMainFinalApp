# syntax=docker/dockerfile:1

# ---------- stage 1: install every dependency (tests + lint need devDeps) ----------
FROM node:22-alpine AS deps
WORKDIR /app
ENV npm_config_fetch_retries=3
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ---------- stage 1b: build the supplied InChat React UI ----------
FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY client/ ./
RUN npm run build

# ---------- stage 2: quality gate, reused by CI ----------
FROM deps AS verify
COPY eslint.config.js ./
COPY src ./src
COPY legacy-ui ./legacy-ui
COPY tests ./tests
RUN npm run lint && npm run test

# ---------- stage 3: production-only dependency set ----------
FROM node:22-alpine AS prod-deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

# ---------- stage 4: runtime ----------
FROM node:22-alpine AS runtime
LABEL org.opencontainers.image.title="groupchat-realtime" \
      org.opencontainers.image.source="https://github.com/gurava947/GchatApp" \
      org.opencontainers.image.description="Real-time group chat (Express + Socket.io + Redis)"

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS="--max-old-space-size=512" \
    UPLOAD_DIR=/app/uploads

WORKDIR /app

# Copy installed modules first so source edits do not invalidate the layer cache.
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node legacy-ui ./legacy-ui
COPY --chown=node:node --from=client-build /app/client/dist ./client/dist

# The base image's package manager is a build-time tool, and its bundled
# dependency tree carries HIGH findings that the image scan would gate on
# forever (they are fixed only in a newer base). The container runs `node
# src/server.js` and nothing else, so the toolchain is removed rather than
# tolerated.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /usr/local/lib/node_modules/corepack \
    && node --version

# Uploads land here; the directory must be writable by the non-root user and
# must be a shared volume whenever more than one replica runs.
RUN mkdir -p /app/uploads

# Writable only where the app needs it; everything else stays root-owned.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;require('http').get('http://127.0.0.1:'+p+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# PID 1 receives SIGTERM directly, which src/server.js drains gracefully.
CMD ["node", "src/server.js"]
