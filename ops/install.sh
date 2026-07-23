#!/usr/bin/env bash
#
# Install / update the Theta42 jump host on a fresh or existing host.
#
# Idempotent: run to install, re-run to update. Installs system dependencies
# (Node, Redis), force-syncs the repo at $REPO_DIR to its remote branch, and
# symlinks the systemd unit straight from the repo so an update is just
# "sync repo + restart".
#
# Secrets live at $SECRETS_FILE (/etc/jump-host/secrets.js by default), outside
# the checkout so they survive the hard reset. First run seeds it from
# secrets.js.example (placeholders you must fill in); later runs never touch it.
#
# Usage: sudo ./install.sh   (override with REPO_URL=, REPO_DIR=, BRANCH=,
#                             SECRETS_FILE=)
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
export DEBIAN_FRONTEND=noninteractive

REPO_URL="${REPO_URL:-https://github.com/theta42/jump-host.git}"
REPO_DIR="${REPO_DIR:-/opt/theta42/jump-host}"
BRANCH="${BRANCH:-master}"
NODE_MAJOR=22
SECRETS_FILE="${SECRETS_FILE:-/etc/jump-host/secrets.js}"
DATA_DIR="${DATA_DIR:-/var/lib/jump-host}"

if [ "$(id -u)" -ne 0 ]; then
	echo "This script must be run as root (try: sudo $0)" >&2
	exit 1
fi

link(){ ln -sfn "$1" "$2"; echo "linked $2 -> $1"; }

pkg_version(){
	sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1
}

CURRENT_VERSION=""
if [ -f "$REPO_DIR/nodejs/package.json" ]; then
	CURRENT_VERSION="$(pkg_version "$REPO_DIR/nodejs/package.json")"
fi

echo "==> Base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git gnupg redis-server >/dev/null

echo "==> Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]; then
	mkdir -p /etc/apt/keyrings
	curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
		| gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
	echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
		> /etc/apt/sources.list.d/nodesource.list
	apt-get update -qq
	apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(node -v)"

echo "==> Redis (enable + start)"
systemctl enable --now redis-server >/dev/null 2>&1 || systemctl enable --now redis >/dev/null 2>&1 || true

echo "==> Repo at $REPO_DIR"
if [ -d "$REPO_DIR/.git" ]; then
	git -C "$REPO_DIR" fetch --prune origin
	git -C "$REPO_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
	git -C "$REPO_DIR" reset --hard "origin/$BRANCH"
	git -C "$REPO_DIR" clean -fd
else
	mkdir -p "$(dirname "$REPO_DIR")"
	git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi
NEW_VERSION="$(pkg_version "$REPO_DIR/nodejs/package.json")"

echo "==> Data dir $DATA_DIR (host keys + state)"
mkdir -p "$DATA_DIR/keys"
chmod 700 "$DATA_DIR" "$DATA_DIR/keys"

echo "==> Secrets at $SECRETS_FILE"
if [ ! -f "$SECRETS_FILE" ]; then
	mkdir -p "$(dirname "$SECRETS_FILE")"
	cp "$REPO_DIR/secrets.js.example" "$SECRETS_FILE"
	chmod 600 "$SECRETS_FILE"
	echo "    seeded from secrets.js.example — EDIT IT before the service will work:"
	echo "      $SECRETS_FILE"
else
	echo "    exists — left untouched"
fi

echo "==> systemd unit"
link "$REPO_DIR/ops/jump-host.service" /etc/systemd/system/jump-host.service

echo "==> npm install (production deps)"
( cd "$REPO_DIR/nodejs" && (npm ci --omit=dev 2>/dev/null || npm install --omit=dev) )

echo "==> Start service"
systemctl daemon-reload
systemctl enable --now jump-host.service
systemctl restart jump-host.service

echo
if [ -z "$CURRENT_VERSION" ]; then
	echo "Installed jump-host v${NEW_VERSION}."
elif [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
	echo "Already up to date (v${NEW_VERSION})."
else
	echo "Updated jump-host v${CURRENT_VERSION} -> v${NEW_VERSION}."
fi
echo "Re-run this script any time to update:  sudo $0"
echo "Logs:  journalctl -u jump-host -f"
