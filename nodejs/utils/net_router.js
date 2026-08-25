'use strict';

// The gateway as a real router: forwarding, NAT, NETMAP, and the sysctls that
// make policy routing behave.
//
// All of this runs on the HOST (or in a system container that looks like one).
// It was unworkable inside a Docker network namespace: `MASQUERADE -o eth0`
// hit a bridge veth rather than the site LAN, NETMAP had no physical network
// to map, and the LAN router's static route pointed at a host the gateway
// wasn't. A router belongs where the interfaces are.
//
// Every function here is IDEMPOTENT. Rules are checked with `-C` before being
// added, so re-running a reconcile does not stack duplicates -- which matters
// because reconcile runs at boot, after every roster change, and on a timer.

const { execFileSync } = require('child_process');

function run(cmd, args) {
	return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function tryRun(cmd, args) {
	try { return { ok: true, out: run(cmd, args) }; }
	catch (e) {
		return {
			ok: false,
			err: (e.stderr || e.message || '').toString(),
			// ENOENT means the binary is not installed at all, which is a
			// different problem from a rule being rejected and deserves a
			// different answer -- see missingTools().
			missing: e.code === 'ENOENT'
		};
	}
}

// Tools this module needs but cannot assume. A gateway running somewhere
// without them is not broken, it is LIMITED: it can still hold tunnels and
// route between sites, and saying so beats throwing halfway through a
// reconcile and skipping everything after it.
const TOOLS = ['iptables', 'sysctl'];
let toolCache = null;

function missingTools() {
	if (toolCache) return toolCache;
	toolCache = TOOLS.filter((tool) => tryRun(tool, ['--version']).missing);
	if (toolCache.length) {
		console.warn(`[router] ${toolCache.join(' and ')} not available — NAT, forwarding and LAN mapping cannot be configured here. ` +
			'The mesh and device tunnels still work; everything that touches the host network does not.');
	}
	return toolCache;
}

function haveIptables() { return !missingTools().includes('iptables'); }

/**
 * Add an iptables rule only if an identical one is not already present.
 * `-C` is the check form; it exits non-zero when the rule is absent.
 */
function ensureRule(table, chain, rule, { append = true } = {}) {
	if (!haveIptables()) return false;
	const base = ['-t', table];
	const check = tryRun('iptables', [...base, '-C', chain, ...rule]);
	if (check.ok) return false;
	const add = tryRun('iptables', [...base, append ? '-A' : '-I', chain, ...rule]);
	if (!add.ok) throw new Error(`iptables -t ${table} ${chain} ${rule.join(' ')}: ${add.err}`);
	return true;
}

function removeRule(table, chain, rule) {
	if (!haveIptables()) return 0;
	const base = ['-t', table];
	// Delete repeatedly: an older build without the -C guard may have stacked
	// duplicates, and leaving one behind would keep NETMAPping a range the
	// operator has removed.
	let removed = 0;
	while (tryRun('iptables', [...base, '-C', chain, ...rule]).ok) {
		if (!tryRun('iptables', [...base, '-D', chain, ...rule]).ok) break;
		removed++;
		if (removed > 32) break; // pathological; stop rather than spin
	}
	return removed;
}

/**
 * Sysctls the routing design depends on.
 *
 * rp_filter is the subtle one. Strict reverse-path filtering drops a packet
 * whose source address would not route back out the interface it arrived on --
 * which is the NORMAL state once policy routing sends a client's traffic out
 * an exit interface while replies arrive on another. With rp_filter left at 1,
 * exit routing silently blackholes and every diagnostic looks fine.
 */
function applySysctls(interfaces = []) {
	const settings = [
		['net.ipv4.ip_forward', '1'],
		['net.ipv4.conf.all.rp_filter', '0'],
		['net.ipv4.conf.default.rp_filter', '0']
	];
	for (const iface of interfaces) {
		if (iface) settings.push([`net.ipv4.conf.${iface}.rp_filter`, '0']);
	}
	const applied = [];
	for (const [key, value] of settings) {
		let res = tryRun('sysctl', ['-w', `${key}=${value}`]);
		if (!res.ok && res.missing) {
			// No sysctl binary: the knobs are still just files. This also fails
			// where /proc/sys is mounted read-only (every default Docker
			// container), which is worth distinguishing from "not installed".
			res = tryRun('sh', ['-c', `echo ${value} > /proc/sys/${key.replace(/\./g, '/')}`]);
		}
		// A per-interface knob for an interface that does not exist yet is not
		// an error worth failing a reconcile over; the next pass will set it.
		if (res.ok) applied.push(key);
		else console.warn(`[router] could not set ${key}: ${(res.err || '').trim()}`);
	}
	return applied;
}

/**
 * Masquerade traffic leaving toward the internet, and allow forwarding between
 * the tunnel and the uplink.
 *
 * @param {string} wanIface  the interface with the default route
 * @param {string[]} tunnels wg interfaces whose traffic may be forwarded out
 */
function applyForwarding(wanIface, tunnels = []) {
	if (!haveIptables()) return { changed: 0, skipped: 'iptables not available' };
	if (!wanIface) return { changed: 0, skipped: 'no WAN interface' };
	let changed = 0;

	// One MASQUERADE on the uplink covers every source that reaches it, rather
	// than one rule per tunnel or per client range.
	if (ensureRule('nat', 'POSTROUTING', ['-o', wanIface, '-j', 'MASQUERADE'])) changed++;

	for (const tun of tunnels) {
		if (ensureRule('filter', 'FORWARD', ['-i', tun, '-o', wanIface, '-j', 'ACCEPT'])) changed++;
		// Return traffic only for flows the inside started -- the internet does
		// not get to open connections into the mesh through this gateway.
		if (ensureRule('filter', 'FORWARD', ['-i', wanIface, '-o', tun, '-m', 'state', '--state', 'RELATED,ESTABLISHED', '-j', 'ACCEPT'])) changed++;
		// Mesh-to-mesh and mesh-to-client forwarding across tunnels.
		for (const other of tunnels) {
			if (other === tun) continue;
			if (ensureRule('filter', 'FORWARD', ['-i', tun, '-o', other, '-j', 'ACCEPT'])) changed++;
		}
	}
	return { changed };
}

/**
 * Let the physical LAN reach the mesh, and the mesh reach the LAN.
 *
 * NETMAP is a 1:1 prefix rewrite, not connection-tracked NAT: the shadow
 * range 10.<s>.<slot>.0/24 and the physical LAN map onto each other host for
 * host, so 10.2.168.53 IS 192.168.1.53. That is what makes every site's LAN
 * globally addressable when they are all 192.168.1.0/24 -- which they are.
 *
 * The `route add local ... dev lo` is what makes the box answer for the shadow
 * range at all; without it the PREROUTING rule never sees the packets, because
 * nothing on the host claims those addresses.
 */
function applyNetmap(wgIface, shadowCidrValue, physicalCidr) {
	if (!haveIptables()) return { changed: 0, skipped: 'iptables not available' };
	if (!wgIface || !shadowCidrValue || !physicalCidr) return { changed: 0 };
	let changed = 0;

	// Inbound: someone on the mesh addresses the shadow, we rewrite to physical.
	if (ensureRule('nat', 'PREROUTING', ['-i', wgIface, '-d', shadowCidrValue, '-j', 'NETMAP', '--to', physicalCidr])) changed++;
	// Outbound: a LAN host answering (or initiating) appears as its shadow.
	if (ensureRule('nat', 'POSTROUTING', ['-o', wgIface, '-s', physicalCidr, '-j', 'NETMAP', '--to', shadowCidrValue])) changed++;

	const localRoute = tryRun('ip', ['route', 'show', 'table', 'local', shadowCidrValue]);
	if (!localRoute.ok || !localRoute.out.trim()) {
		const add = tryRun('ip', ['route', 'add', 'local', shadowCidrValue, 'dev', 'lo']);
		if (add.ok) changed++;
		else if (!/File exists/.test(add.err)) {
			console.warn(`[router] could not claim ${shadowCidrValue} locally: ${add.err.trim()}`);
		}
	}

	// Let LAN hosts reach the mesh at all.
	if (ensureRule('nat', 'POSTROUTING', ['-s', physicalCidr, '-o', wgIface, '-j', 'MASQUERADE'])) changed++;
	return { changed };
}

function removeNetmap(wgIface, shadowCidrValue, physicalCidr) {
	if (!wgIface || !shadowCidrValue || !physicalCidr) return 0;
	let removed = 0;
	removed += removeRule('nat', 'PREROUTING', ['-i', wgIface, '-d', shadowCidrValue, '-j', 'NETMAP', '--to', physicalCidr]);
	removed += removeRule('nat', 'POSTROUTING', ['-o', wgIface, '-s', physicalCidr, '-j', 'NETMAP', '--to', shadowCidrValue]);
	removed += removeRule('nat', 'POSTROUTING', ['-s', physicalCidr, '-o', wgIface, '-j', 'MASQUERADE']);
	tryRun('ip', ['route', 'del', 'local', shadowCidrValue, 'dev', 'lo']);
	return removed;
}

/**
 * The interface carrying the default route -- what to MASQUERADE out of.
 * Detected rather than configured: on a host the answer is unambiguous, and
 * one less thing for an operator to get wrong.
 */
function detectWanInterface() {
	const res = tryRun('ip', ['-o', 'route', 'show', 'default']);
	if (!res.ok) return null;
	// "default via 192.168.1.1 dev enp3s0 proto dhcp metric 100"
	const m = /\sdev\s+(\S+)/.exec(res.out.split('\n')[0] || '');
	return m ? m[1] : null;
}

/**
 * The site's DNS resolver, as an address on the site LAN.
 *
 * A client on the tunnel needs a resolver it can actually reach over the
 * tunnel. Until now nothing ever supplied one: `dnsHost` was configurable and
 * left null everywhere, so every pushed client config omitted `DNS =`
 * entirely. A device with the tunnel up therefore kept using whatever resolver
 * the network it was physically sitting on had handed it -- which resolves no
 * internal name, and hands every lookup to a coffee-shop DHCP server while the
 * user believes their traffic is protected.
 *
 * Two sources, best first:
 *
 *  1. A nameserver in /etc/resolv.conf that is a real private address. That is
 *     the resolver this gateway itself was told to use, which is as close to
 *     "the site's resolver" as anything on the box knows. Loopback entries are
 *     skipped: 127.0.0.53 is systemd-resolved and 127.0.0.11 is Docker's
 *     embedded DNS, and neither means anything to a client on the far end.
 *  2. The default-route gateway, when it is private. On a small site the LAN
 *     router is the DNS server essentially always.
 *
 * Only ever a SUGGESTION -- published as `dnsHostDetected`, and the directory
 * takes it only while an admin has not set one (utils/mesh_roster.js). A wrong
 * guess is cheap: the directory refuses to push an address that is not inside
 * a mapped LAN, so the client config comes out exactly as it does today.
 */
function detectResolver() {
	const res = tryRun('cat', ['/etc/resolv.conf']);
	if (res.ok) {
		for (const line of res.out.split('\n')) {
			const m = /^\s*nameserver\s+(\S+)/.exec(line);
			if (m && isPrivateIPv4(m[1])) return m[1];
		}
	}
	const route = tryRun('ip', ['-o', 'route', 'show', 'default']);
	if (route.ok) {
		// "default via 192.168.1.1 dev enp3s0 proto dhcp metric 100"
		const m = /\svia\s+(\S+)/.exec(route.out.split('\n')[0] || '');
		if (m && isPrivateIPv4(m[1])) return m[1];
	}
	return null;
}

/**
 * RFC1918 only, and deliberately not loopback: a resolver a client cannot
 * reach over the tunnel is worse than none, because it replaces a working
 * local resolver with a dead one.
 */
function isPrivateIPv4(addr) {
	const parts = String(addr).split('.');
	if (parts.length !== 4) return false;
	const [a, b] = parts.map(Number);
	if (parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	return false;
}

/** Does this kernel have the NETMAP target available? */
function netmapAvailable() {
	if (!haveIptables()) return false;
	// -C against a chain that does not exist still parses the target, so a
	// "No chain/target/match" error distinguishes "NETMAP missing" from
	// "rule absent".
	const res = tryRun('iptables', ['-t', 'nat', '-C', 'POSTROUTING', '-s', '192.0.2.0/24', '-j', 'NETMAP', '--to', '198.51.100.0/24']);
	if (res.ok) return true;
	return !/No chain\/target\/match|Unknown arg|unknown option/i.test(res.err);
}

module.exports = {
	applySysctls, applyForwarding, applyNetmap, removeNetmap,
	detectWanInterface, detectResolver, isPrivateIPv4, netmapAvailable, missingTools, ensureRule, removeRule,
	_run: run, _tryRun: tryRun, _resetToolCache: () => { toolCache = null; }
};
