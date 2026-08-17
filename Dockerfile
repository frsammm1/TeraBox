# syntax=docker/dockerfile:1

# ---- deps + build stage ----
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
# No lockfile is shipped by default; npm install resolves against package.json.
# If you commit a package-lock.json, this will automatically use `npm ci` instead.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# `zip` is required at runtime for ZipArchiveSplitter (oversized-file splitting
# before upload). ca-certificates is required for outbound HTTPS to TeraBox/Telegram.
RUN apt-get update \
    && apt-get install -y --no-install-recommends zip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY --from=build /app/dist ./dist

# Heroku injects PORT at runtime; the app already reads it via config.ts.
# Non-root user for safety.
RUN useradd --create-home --shell /bin/bash appuser \
    && mkdir -p /tmp/terabox-transfers \
    && chown -R appuser:appuser /app /tmp/terabox-transfers
USER appuser

CMD ["node", "dist/index.js"]
