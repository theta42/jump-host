'use strict';

// Bring up a local WireGuard interface, preferring the in-kernel
// implementation and falling back to the userspace `wireguard-go` reference
// implementation when the kernel module isn't available (older/hardened
// kernels, some container/cloud images, non-Linux). Both paths end with an
// identically-named network interface that `wg`/`ip` commands (and the rest
// of this module) treat the same way -- callers never need to know which
// mode ended up in use.

const { execFileSync, spawn } = require('child_process');

const probes = new Map(); // name -> { mode, process (userspace only) }

function run(cmd, args) {
	return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function tryRun(cmd, args) {
	try { return { ok: true, out: run(cmd, args) }; }
	catch (e) { return { ok: false, err: (e.stderr || e.message || '').toString() }; }
}

// One-time, cheap probe: can this kernel create a wireguard-type link at
// all? Uses a throwaway interface name so it never collides with a real one.
let kernelSupport = null;
function kernelWireguardAvailable() {
	if (kernelSupport !== null) return kernelSupport;
	const probeName = 'wgprobe' + process.pid;
	const add = tryRun('ip', ['link', 'add', 'dev', probeName, 'type', 'wireguard']);
	if (add.ok) {
		tryRun('ip', ['link', 'del', 'dev', probeName]);
		kernelSupport = true;
	} else {
		kernelSupport = false;
	}
	return kernelSupport;
}

function interfaceExists(name) {
	return tryRun('ip', ['link', 'show', 'dev', name]).ok;
}

async function waitForInterface(name, timeoutMs = 5000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (interfaceExists(name)) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

// Idempotent: calling this again for an interface that's already up (kernel
// or userspace) is a no-op, not an error.
async function ensureInterface(name) {
	if (interfaceExists(name)) {
		return { mode: probes.get(name) ? probes.get(name).mode : 'kernel' };
	}

	if (kernelWireguardAvailable()) {
		const add = tryRun('ip', ['link', 'add', 'dev', name, 'type', 'wireguard']);
		if (!add.ok && !/File exists/.test(add.err)) {
			throw new Error(`kernel WireGuard interface creation failed: ${add.err}`);
		}
		probes.set(name, { mode: 'kernel' });
		console.log(`[wg_iface] ${name}: using in-kernel WireGuard`);
		return { mode: 'kernel' };
	}

	// Userspace fallback: wireguard-go daemonizes and creates the TUN device
	// itself; we just wait for it to appear rather than assuming a fixed delay.
	console.log(`[wg_iface] ${name}: kernel WireGuard unavailable, falling back to wireguard-go (userspace)`);
	const child = spawn('wireguard-go', [name], { detached: true, stdio: 'ignore' });
	child.unref();
	const up = await waitForInterface(name);
	if (!up) throw new Error(`wireguard-go did not bring up interface '${name}' within timeout`);
	probes.set(name, { mode: 'userspace', pid: child.pid });
	return { mode: 'userspace', pid: child.pid };
}

function setPrivateKey(name, privateKeyBase64, listenPort) {
	// `wg setconf` reads the private key from a file, not argv (argv would leak
	// it via /proc/<pid>/cmdline to anyone on the host). Pipe it through stdin
	// via a temp file instead -- see setPeer's note on the same tradeoff.
	// ListenPort matters: without one, WG binds an ephemeral port, which is
	// fine for a purely outbound roaming client but useless for a gateway
	// another gateway needs to dial back into as an Endpoint.
	const fs = require('fs');
	const os = require('os');
	const path = require('path');
	const tmp = path.join(os.tmpdir(), `wg-${name}-${Date.now()}.conf`);
	const lines = ['[Interface]', `PrivateKey = ${privateKeyBase64}`];
	if (listenPort) lines.push(`ListenPort = ${listenPort}`);
	fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
	try {
		run('wg', ['setconf', name, tmp]);
	} finally {
		fs.unlinkSync(tmp);
	}
}

function setAddress(name, cidr) {
	// Flush first so re-applying (e.g. after a mesh index reassignment, which
	// shouldn't normally happen but must not silently stack addresses if it
	// does) leaves exactly one address, not an accumulating list.
	tryRun('ip', ['addr', 'flush', 'dev', name]);
	run('ip', ['addr', 'add', cidr, 'dev', name]);
	run('ip', ['link', 'set', 'up', 'dev', name]);
}

// Apply (or update) one peer. Safe to call repeatedly for the same peer --
// `wg set ... peer <pub>` upserts.
//
// `wg set ... allowed-ips` ONLY configures WireGuard's own crypto-routing
// table (which packets get encrypted/decrypted for this peer) -- it does
// NOT add a kernel route for that destination. wg-quick does that as a
// separate step; since we drive `wg`/`ip` directly (no wg-quick), we have to
// add it ourselves or the tunnel handshakes fine but nothing ever actually
// routes through it (confirmed the hard way: a real encrypted handshake
// completed between two containers with zero kernel route present, and
// ping still showed 100% loss).
function setPeer(name, { publicKey, endpoint, allowedIPs, keepalive }) {
	const ips = allowedIPs || [];
	const args = ['set', name, 'peer', publicKey, 'allowed-ips', ips.join(',')];
	if (endpoint) args.push('endpoint', endpoint);
	if (keepalive) args.push('persistent-keepalive', String(keepalive));
	run('wg', args);

	for (const cidr of ips) {
		const add = tryRun('ip', ['route', 'add', cidr, 'dev', name]);
		// "File exists" happens when the interface's own /24 already covers
		// this range (added automatically by `ip addr add`) -- fine, not an
		// error. Anything else should surface.
		if (!add.ok && !/File exists/.test(add.err)) {
			throw new Error(`failed to add kernel route ${cidr} via ${name}: ${add.err}`);
		}
	}
}

// TODO: doesn't clean up the kernel routes setPeer added for this peer's
// AllowedIPs (would need to record or query them first) -- not exercised by
// any caller yet (nothing in this codebase removes a mesh peer today), but
// flagging so whoever adds that doesn't get bitten by stale routes.
function removePeer(name, publicKey) {
	tryRun('wg', ['set', name, 'peer', publicKey, 'remove']);
}

module.exports = {
	kernelWireguardAvailable,
	ensureInterface,
	setPrivateKey,
	setAddress,
	setPeer,
	removePeer,
	interfaceExists
};
