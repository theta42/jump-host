#!/usr/bin/env bash
# Start the theta42/jump-host all-in-one container: Redis (background) + the
# Node app (foreground, PID 2 under dumb-init so it gets SIGTERM).
set -e

info() { echo "[INFO] $*"; }

# When the unified theta-env stack (or any deployment) bind-mounts
# ./config/jump-secrets.js at /config, point CONF_SECRETS at it.
if [[ -f /config/jump-secrets.js ]]; then
	export CONF_SECRETS=/config/jump-secrets.js
	info "Loaded config from /config/jump-secrets.js"
fi

# Redis for audit/metrics/session AND api-token storage (app connects to
# 127.0.0.1:6379). Persisted (AOF + periodic RDB) to /data, which the
# deployment should mount as a volume -- without this, every container
# recreation silently wiped every session, in-flight OAuth login, and any
# admin-created API token, which is especially bad for the last one since a
REDIS_DATA_DIR="${REDIS_DATA_DIR:-/data}"
mkdir -p "$REDIS_DATA_DIR"
# Local Redis holds WireGuard keys, sessions and API tokens -- require auth even
# on loopback so a local process that can reach 127.0.0.1:6379 cannot read them
# without the password. Generate one per container if not supplied; the app
# reads app_redis__password below.
REDIS_PASSWORD="${REDIS_PASSWORD:-$(openssl rand -hex 32)}"
export app_redis__password="$REDIS_PASSWORD"
info "Starting redis (AOF persisted to $REDIS_DATA_DIR, requirepass set)..."
redis-server --daemonize yes --dir "$REDIS_DATA_DIR" --appendonly yes \
	--appendfilename appendonly.aof --save 900 1 --save 300 10 --save 60 10000 \
	--requirepass "$REDIS_PASSWORD"

# Wait for redis to answer before starting the app. Auth required now, so pass
# the password to redis-cli.
for _ in $(seq 1 20); do
	if redis-cli -a "$REDIS_PASSWORD" ping >/dev/null 2>&1; then break; fi
	sleep 0.2
done

export NODE_ENV="${NODE_ENV:-production}"
info "Starting jump-host (SSH :${JUMP_SSH_PORT:-2222}, web :3002)..."
exec "$@"
