# Theta42 jump host — all-in-one image (Node app + Redis), mirroring the
# proxy/sso-manager packaging (dumb-init PID 1, gitinfo stage baking the commit).

ARG GIT_COMMIT=""
FROM node:22-bookworm-slim AS gitinfo
ARG GIT_COMMIT
WORKDIR /repo
COPY .git ./.git
RUN if [ -n "$GIT_COMMIT" ]; then \
        echo "$GIT_COMMIT" > /commit.txt; \
    else \
        { apt-get update && apt-get install -y --no-install-recommends git \
        && git rev-parse --short HEAD > /commit.txt; } 2>/dev/null || echo unknown > /commit.txt; \
    fi

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        redis-server dumb-init ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps first for layer caching (.dockerignore excludes
# nodejs/node_modules so npm ci builds a clean tree).
COPY nodejs/package*.json ./
RUN npm ci --omit=dev

COPY nodejs/app.js ./
COPY nodejs/bin ./bin
COPY nodejs/conf ./conf
COPY nodejs/middleware ./middleware
COPY nodejs/models ./models
COPY nodejs/routes ./routes
COPY nodejs/services ./services
COPY nodejs/utils ./utils
COPY nodejs/views ./views
COPY nodejs/public ./public

COPY README.md CHANGELOG.md DEPLOYMENT.md /
COPY --from=gitinfo /commit.txt ./.build_commit

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /var/lib/jump-host/keys && chmod 700 /var/lib/jump-host /var/lib/jump-host/keys

# 2222: SSH front door.  3002: web UI/API.
EXPOSE 2222 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3002/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "bin/www"]
