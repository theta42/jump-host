#!/usr/bin/env bash
# Install Theta Gateway on this host.
#
# The gateway is the one Theta Suite component that does NOT run in a
# container, because it is a router. NETMAP of the physical LAN, MASQUERADE out
# the real uplink, net.* sysctls in the host namespace, and being the next hop
# for your LAN's 10.0.0.0/8 route are all things a Docker network namespace
# cannot do -- see docs/jump-host/deployment.md for the alternatives that were
# tried and why each was rejected.
#
# Idempotent: safe to re-run to upgrade in place. Config and data are
# preserved; only the application tree is replaced.
#
#   sudo ./install.sh                 # install or upgrade from this checkout
#   sudo ./install.sh --uninstall     # stop, disable, remove (keeps data)
set -euo pipefail

APP_ROOT=/opt/theta-gateway
CONFIG_DIR=/etc/theta-gateway
DATA_DIR=/var/lib/theta-gateway
REDIS_DIR="$DATA_DIR/redis"
UNIT=/etc/systemd/system/theta-gateway.service
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { echo "[install] $*"; }
warn() { echo "[install] WARNING: $*" >&2; }
die()  { echo "[install] ERROR: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (the gateway configures host networking)"

# ── uninstall ────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--uninstall" ]]; then
	info "Stopping and disabling theta-gateway..."
	systemctl disable --now theta-gateway.service 2>/dev/null || true
	rm -f "$UNIT"
	systemctl daemon-reload
	rm -rf "$APP_ROOT"
	# Config and data are deliberately kept: the WireGuard identity lives in
	# Redis, and every peer in the cluster holds its public half. Deleting it
	# silently breaks every tunnel to this site.
	info "Removed the service and $APP_ROOT."
	info "KEPT $CONFIG_DIR and $DATA_DIR — $DATA_DIR holds this gateway's WireGuard identity,"
	info "which every peer in the cluster has. Delete it only if this site is gone for good."
	exit 0
fi

# ── dependencies ─────────────────────────────────────────────────────────────
# iptables and procps are what the container image was missing, which is why a
# containerised gateway could hold tunnels but not NAT, forward, or map a LAN.
PKGS=(redis-server iproute2 iptables wireguard-tools procps)
MISSING=()
command -v redis-server >/dev/null || MISSING+=(redis-server)
command -v ip           >/dev/null || MISSING+=(iproute2)
command -v iptables     >/dev/null || MISSING+=(iptables)
command -v wg           >/dev/null || MISSING+=(wireguard-tools)
command -v sysctl       >/dev/null || MISSING+=(procps)

if ((${#MISSING[@]})); then
	if command -v apt-get >/dev/null; then
		info "Installing: ${MISSING[*]}"
		apt-get update -qq
		DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${MISSING[@]}" >/dev/null
	else
		die "missing ${MISSING[*]} and no apt-get here — install them, then re-run. Needed: ${PKGS[*]}"
	fi
fi

# In-kernel WireGuard is preferred; wireguard-go is the fallback for kernels
# without the module. Install the fallback opportunistically -- it is small,
# and discovering it is missing on a hardened kernel at 2am is not fun.
if ! command -v wireguard-go >/dev/null; then
	if command -v apt-get >/dev/null; then
		DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends wireguard-go >/dev/null 2>&1 || true
	fi
fi
if ! command -v wireguard-go >/dev/null && ! modinfo wireguard >/dev/null 2>&1; then
	warn "no in-kernel WireGuard and no wireguard-go — the gateway cannot create interfaces"
fi

# Node. The gateway used to run in a container carrying its own runtime, so a
# host never needed one; running on the host means it does. Install it rather
# than stopping, since "install node yourself" is a poor place to end a setup
# that has already brought the rest of the stack up.
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if ! command -v node >/dev/null || (( $(node_major) < 20 )); then
	FOUND="$(command -v node >/dev/null && node -v || echo 'none')"
	if [[ "${THETA_SKIP_NODE_INSTALL:-}" == "1" ]]; then
		die "node >= 20.14 required (found $FOUND) and THETA_SKIP_NODE_INSTALL=1"
	fi
	if command -v apt-get >/dev/null && command -v curl >/dev/null; then
		info "Installing Node.js 22 from NodeSource (found: $FOUND)..."
		# Debian/Ubuntu ship Node 18, which is below the engines floor, so the
		# distro package is not an option here. Set THETA_SKIP_NODE_INSTALL=1 to
		# manage the runtime yourself.
		curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 \
			|| die "could not add the NodeSource repository — install node >= 20.14 yourself, then re-run"
		DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs >/dev/null \
			|| die "installing nodejs failed — install node >= 20.14 yourself, then re-run"
	else
		die "node >= 20.14 required (found $FOUND). Install it, then re-run."
	fi
fi
(( $(node_major) >= 20 )) || die "node >= 20.14 required, found $(node -v)"

# ── the one conflict worth checking up front ─────────────────────────────────
# The gateway's SSH front door must not collide with the host's own sshd, or
# the install "succeeds" and locks you out of the box.
SSH_PORT="${JUMP_SSH_PORT:-2222}"
if ss -lntp 2>/dev/null | grep -qE "[:.]${SSH_PORT}\b"; then
	# On an upgrade the gateway's own running instance legitimately holds the
	# port — that is not a conflict, and install.sh restarts it below anyway.
	# Only die when somebody else owns it.
	OWN_PID="$(systemctl show -p MainPID --value theta-gateway.service 2>/dev/null || true)"
	if [[ -z "$OWN_PID" || "$OWN_PID" == "0" ]] \
		|| ! ss -lntp 2>/dev/null | grep -qE "pid=${OWN_PID}[,) ]"; then
		die "port ${SSH_PORT} is already in use — set JUMP_SSH_PORT to something free and re-run"
	fi
fi

# ── application tree ─────────────────────────────────────────────────────────
info "Installing the application to $APP_ROOT..."
mkdir -p "$APP_ROOT" "$CONFIG_DIR" "$DATA_DIR" "$REDIS_DIR"
chmod 700 "$CONFIG_DIR"

# Replace the tree rather than merging into it, so a file deleted upstream does
# not linger and get loaded by a later release. Keep existing node_modules to avoid
# a slow clean download on every update when dependencies haven't changed.
if [[ -d "$APP_ROOT/nodejs/node_modules" ]]; then
	TEMP_MODULES="$(mktemp -d)"
	mv "$APP_ROOT/nodejs/node_modules" "$TEMP_MODULES/"
	rm -rf "$APP_ROOT/nodejs"
	mkdir -p "$APP_ROOT/nodejs"
	tar -C "$SRC/nodejs" --exclude=node_modules --exclude=.git -cf - . | tar -C "$APP_ROOT/nodejs" -xf -
	mv "$TEMP_MODULES/node_modules" "$APP_ROOT/nodejs/"
	rm -rf "$TEMP_MODULES"
else
	rm -rf "$APP_ROOT/nodejs"
	mkdir -p "$APP_ROOT/nodejs"
	tar -C "$SRC/nodejs" --exclude=node_modules --exclude=.git -cf - . | tar -C "$APP_ROOT/nodejs" -xf -
fi

info "Installing production dependencies..."
( cd "$APP_ROOT/nodejs" && npm ci --omit=dev --prefer-offline --silent 2>/dev/null || npm install --omit=dev --silent )

# ── redis ────────────────────────────────────────────────────────────────────
# Bound to loopback explicitly. In a container this was implicitly private; on
# a host, an unbound Redis holding sessions, OAuth state and API tokens is
# listening on the LAN.
install -m 0644 /dev/stdin /etc/redis/theta-gateway.conf <<EOF
# Theta Gateway's Redis. Managed by install.sh -- edits will be overwritten.
bind 127.0.0.1 ::1
port 6379
dir $REDIS_DIR
appendonly yes
appendfilename appendonly.aof
save 900 1
save 300 10
save 60 10000
EOF

if systemctl list-unit-files 2>/dev/null | grep -q '^redis-server\.service'; then
	# Point the distro unit at the gateway's config (custom dir, AOF on) rather
	# than silently running the distro default: the config file written above
	# is dead weight otherwise, and the gateway's identity/sessions/OAuth state
	# would persist to the distro default path nobody documents or backs up.
	# Keep systemd-supervised mode (Debian's stock unit uses it) so Redis does
	# not daemonize on its own under systemd.
	install -d -m 0755 /etc/systemd/system/redis-server.service.d
	install -m 0644 /dev/stdin /etc/systemd/system/redis-server.service.d/theta-gateway.conf <<EOF
[Service]
ExecStart=
ExecStart=/usr/bin/redis-server /etc/redis/theta-gateway.conf --supervised systemd --daemonize no
EOF
	systemctl daemon-reload >/dev/null 2>&1 || true
	systemctl enable --now redis-server >/dev/null 2>&1 || true
else
	warn "no redis-server unit found — start Redis yourself on 127.0.0.1:6379"
fi

# ── environment ──────────────────────────────────────────────────────────────
# Written once and then left alone, so an upgrade never overwrites the
# operator's settings.
if [[ ! -f "$CONFIG_DIR/gateway.env" ]]; then
	info "Writing $CONFIG_DIR/gateway.env (first install)"
	install -m 0600 /dev/stdin "$CONFIG_DIR/gateway.env" <<EOF
# Theta Gateway environment. Created by install.sh; safe to edit.

# Secrets file written by theta-suite's bootstrap (LDAP bind, API token, OIDC).
CONF_SECRETS=$CONFIG_DIR/jump-secrets.js

# The rest of the stack runs in containers on this host and publishes these
# ports, so the gateway reaches them over loopback rather than by service name.
DIRECTORY_INTERNAL_URL=http://127.0.0.1:3001
VAULT_ADDR=http://127.0.0.1:8080

# Scoped OpenBao token (policy jump-host). theta-suite's setup.sh fills this in.
VAULT_TOKEN=

# The host:port OTHER SITES dial for WireGuard. Publish it in DNS and open the
# UDP port. Empty is legitimate -- this site then reaches out and is reached
# back through the hub -- but nothing can dial it directly.
# Defaults to this host's public jump hostname on the standard WireGuard port.
THETA_MESH_ENDPOINT=${THETA_MESH_ENDPOINT:-${JUMP_HOST}:${JUMP_WG_PORT:-51820}}

# SSH front door. Must not collide with this host's own sshd.
JUMP_SSH_PORT=$SSH_PORT

REDIS_DATA_DIR=$REDIS_DIR

# SSH host keys. Generated on first boot and then stable -- clients pin them,
# so losing these makes every user see a host-key-changed warning.
app_ssh__hostKeyPath=$DATA_DIR/keys
EOF
else
	info "Keeping the existing $CONFIG_DIR/gateway.env"
fi

if [[ ! -f "$CONFIG_DIR/jump-secrets.js" ]]; then
	warn "$CONFIG_DIR/jump-secrets.js is missing — theta-suite's setup.sh writes it."
	warn "The gateway will start but cannot authenticate against the directory until it exists."
fi

# ── service ──────────────────────────────────────────────────────────────────
info "Installing the systemd unit..."
install -m 0644 "$SRC/packaging/theta-gateway.service" "$UNIT"
systemctl daemon-reload
systemctl enable theta-gateway.service >/dev/null
systemctl restart theta-gateway.service

sleep 2
if systemctl is-active --quiet theta-gateway.service; then
	info "theta-gateway is running."
else
	die "theta-gateway failed to start — see: journalctl -u theta-gateway -n 50"
fi

cat <<EOF

[install] Done.

  Web UI     http://127.0.0.1:3002   (front it with theta-proxy)
  SSH        port ${SSH_PORT}
  Config     $CONFIG_DIR/gateway.env
  Logs       journalctl -u theta-gateway -f

Next, for this site to route its LAN, add two static routes on your LAN router:

  10.0.0.0/8            -> this host's LAN address
  10.<siteId>.0.0/16    -> on-link (keeps local traffic off the gateway)

Its site id and addresses appear on the gateway's Site Network page once it has
joined a directory.
EOF
