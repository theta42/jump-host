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

# Redis for audit/metrics/session storage (app connects to 127.0.0.1:6379).
info "Starting redis..."
redis-server --daemonize yes --save '' --appendonly no

# Wait for redis to answer before starting the app.
for _ in $(seq 1 20); do
	if redis-cli ping >/dev/null 2>&1; then break; fi
	sleep 0.2
done

export NODE_ENV="${NODE_ENV:-production}"
info "Starting jump-host (SSH :${JUMP_SSH_PORT:-2222}, web :3002)..."
exec "$@"
