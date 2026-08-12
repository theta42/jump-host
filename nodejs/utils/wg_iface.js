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

// `wg set ... private-key <file>` and NOT `wg setconf`: both read the key from
// a file rather than argv (argv would leak it via /proc/<pid>/cmdline to
// anyone on the host), but `setconf` APPLIES a whole config, which means it
// deletes every peer not named in that file. Applying an [Interface]-only
// config -- which is all this function has -- therefore wipes the interface's
// entire peer list. That is exactly what used to happen on each mesh change:
// registering a second gateway tore down the tunnel to the first, because
// setPrivateKey ran before setPeer and took the existing peers with it.
// Verified against wireguard-go in the gateway image: setconf 1 peer -> 0,
// `wg set private-key` leaves 2 peers at 2.
//
// ListenPort matters: without one, WG binds an ephemeral port, which is fine
// for a purely outbound roaming client but useless for a gateway another
// gateway needs to dial back into as an Endpoint.
function setPrivateKey(name, privateKeyBase64, listenPort) {
	const fs = require('fs');
	const os = require('os');
	const path = require('path');
	const tmp = path.join(os.tmpdir(), `wg-${name}-${Date.now()}.key`);
	fs.writeFileSync(tmp, privateKeyBase64 + '\n', { mode: 0o600 });
	try {
		const args = ['set', name, 'private-key', tmp];
		if (listenPort) args.push('listen-port', String(listenPort));
		run('wg', args);
	} finally {
		fs.unlinkSync(tmp);
	}
}

function setAddress(name, cidr) {
	setAddresses(name, [cidr]);
}

/**
 * Give the interface exactly this set of addresses.
 *
 * A gateway carries two: its mesh identity (172.24.0.<s>/32) and its site
 * router address (10.<s>.0.1/16). Reconciled as a SET rather than flushed and
 * re-added, because flushing drops the addresses for an instant on every
 * reconcile -- and reconcile runs on a timer, so that would be a periodic
 * blip on a live router for no reason.
 */
function setAddresses(name, cidrs) {
	const wanted = new Set(cidrs);
	const shown = tryRun('ip', ['-o', '-4', 'addr', 'show', 'dev', name]);
	const present = new Set();
	if (shown.ok) {
		for (const line of shown.out.split('\n')) {
			const m = /\sinet\s+(\S+)/.exec(line);
			if (m) present.add(m[1]);
		}
	}

	for (const cidr of wanted) {
		if (present.has(cidr)) continue;
		const add = tryRun('ip', ['addr', 'add', cidr, 'dev', name]);
		if (!add.ok && !/File exists/.test(add.err)) {
			throw new Error(`failed to add ${cidr} to ${name}: ${add.err}`);
		}
	}
	for (const cidr of present) {
		if (!wanted.has(cidr)) tryRun('ip', ['addr', 'del', cidr, 'dev', name]);
	}

	run('ip', ['link', 'set', 'up', 'dev', name]);
}

/** Public keys of every peer currently on the interface. */
function listPeers(name) {
	const res = tryRun('wg', ['show', name, 'peers']);
	if (!res.ok) return [];
	return res.out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Add a route if it is not already there. Separate from setPeer because the
 * mesh-wide routes (10.0.0.0/8, 172.24.0.0/16) belong to the interface, not to
 * any one peer -- WireGuard's own AllowedIPs decide which tunnel a packet
 * takes once it has been routed in.
 */
function ensureRoute(cidr, dev) {
	const existing = tryRun('ip', ['route', 'show', cidr, 'dev', dev]);
	if (existing.ok && existing.out.trim()) return false;
	const add = tryRun('ip', ['route', 'add', cidr, 'dev', dev]);
	if (!add.ok && !/File exists/.test(add.err)) {
		throw new Error(`failed to add route ${cidr} via ${dev}: ${add.err}`);
	}
	return add.ok;
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

// Removes the peer AND the kernel routes setPeer() added for its
// AllowedIPs -- query them BEFORE removing the peer (once gone, `wg` no
// longer knows what to clean up, and nothing else tracks these routes,
// since they were added by us directly, not by wg-quick).
//
// Safe to assume none of a peer's AllowedIPs collide with this gateway's own
// address range: site ids are allocated once, cluster-wide, by the directory
// master, so a peer's 10.<peerId>.0.0/16 can never equal our own 10.<ourId>.0.0/16.
function removePeer(name, publicKey) {
	const show = tryRun('wg', ['show', name, 'allowed-ips']);
	let allowedIPs = [];
	if (show.ok) {
		const line = show.out.split('\n').find((l) => l.startsWith(publicKey + '\t'));
		if (line) {
			allowedIPs = (line.split('\t')[1] || '').split(/\s+/).filter((ip) => ip && ip !== '(none)');
		}
	}

	tryRun('wg', ['set', name, 'peer', publicKey, 'remove']);

	for (const cidr of allowedIPs) {
		tryRun('ip', ['route', 'del', cidr, 'dev', name]);
	}
}

// Live per-peer status straight from the kernel/userspace device: has this
// peer ever completed a handshake, and how recently? The registry's
// `lastSeenAt` only records when a peer REGISTERED, which says nothing about
// whether the tunnel is currently up -- this does.
//
// `wg show <iface> dump` is used rather than the human-readable output
// because it is stable and parseable. Its FIRST line is the interface itself
// and begins with THIS GATEWAY'S PRIVATE KEY -- it is skipped, and only the
// per-peer fields below are ever returned, so the private key cannot leak
// into an API response.
//
// Peer line: publickey presharedkey endpoint allowed-ips latest-handshake
//            transfer-rx transfer-tx persistent-keepalive
function peerStatus(name) {
	const dump = tryRun('wg', ['show', name, 'dump']);
	if (!dump.ok) return {};
	const out = {};
	const lines = dump.out.trim().split('\n').slice(1); // skip the interface line
	for (const line of lines) {
		const f = line.split('\t');
		if (f.length < 7) continue;
		const handshake = Number(f[4]) || 0;
		out[f[0]] = {
			endpoint: f[2] === '(none)' ? null : f[2],
			latestHandshake: handshake,
			// A peer that has never handshaken reports 0, not a timestamp.
			handshakeAgeSeconds: handshake ? Math.max(0, Math.floor(Date.now() / 1000) - handshake) : null,
			rxBytes: Number(f[5]) || 0,
			txBytes: Number(f[6]) || 0
		};
	}
	return out;
}

module.exports = {
	kernelWireguardAvailable,
	ensureInterface,
	setPrivateKey,
	setAddress,
	setAddresses,
	listPeers,
	ensureRoute,
	setPeer,
	removePeer,
	interfaceExists,
	peerStatus
};
