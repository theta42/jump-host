'use strict';

// Router plumbing: the exact commands issued for NAT, forwarding and NETMAP.
// Asserted at the argv level because these rules are load-bearing and silently
// wrong rules are the whole failure mode -- a missing rp_filter knob or a
// stacked duplicate NETMAP looks fine until traffic quietly disappears.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Intercept the child_process calls the module makes, so nothing touches the
// host's real routing table.
const calls = [];
let responses = {};

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
	if (id === 'child_process') {
		return {
			execFileSync: (cmd, args) => {
				const key = [cmd, ...args].join(' ');
				calls.push(key);
				const canned = responses[key];
				if (canned instanceof Error) throw canned;
				if (canned !== undefined) return canned;
				// Default: iptables -C reports "rule absent", everything else
				// succeeds silently.
				if (args.includes('-C')) {
					const err = new Error('No such rule');
					err.stderr = Buffer.from('iptables: Bad rule');
					throw err;
				}
				return '';
			}
		};
	}
	return originalRequire.apply(this, arguments);
};

const netRouter = require('../../utils/net_router');
Module.prototype.require = originalRequire;

beforeEach(() => {
	calls.length = 0;
	responses = {};
	netRouter._resetToolCache();
});

// ENOENT: the binary is not installed. Simulates a gateway running somewhere
// without iptables -- which is not broken, only limited.
const missing = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

const issued = (fragment) => calls.filter((c) => c.includes(fragment));

test('forwarding enables ip_forward and disables reverse-path filtering', () => {
	netRouter.applySysctls(['wg-mesh', 'enp3s0']);

	assert.ok(issued('net.ipv4.ip_forward=1').length);
	// Strict rp_filter drops packets whose source would not route back out the
	// interface they arrived on -- which is the NORMAL state once policy
	// routing sends a client out an exit. Left at 1, exit routing silently
	// blackholes while every other diagnostic looks healthy.
	assert.ok(issued('net.ipv4.conf.all.rp_filter=0').length);
	assert.ok(issued('net.ipv4.conf.wg-mesh.rp_filter=0').length);
	assert.ok(issued('net.ipv4.conf.enp3s0.rp_filter=0').length);
});

test('a missing per-interface sysctl does not fail the reconcile', () => {
	responses['sysctl -w net.ipv4.conf.ghost0.rp_filter=0'] = Object.assign(new Error('no such key'), { stderr: Buffer.from('sysctl: cannot stat') });
	const applied = netRouter.applySysctls(['ghost0']);
	assert.ok(!applied.includes('net.ipv4.conf.ghost0.rp_filter'));
	assert.ok(applied.includes('net.ipv4.ip_forward'));
});

test('masquerade is applied once on the uplink, not per tunnel', () => {
	netRouter.applyForwarding('enp3s0', ['wg-mesh']);
	assert.strictEqual(issued('-A POSTROUTING -o enp3s0 -j MASQUERADE').length, 1);
});

test('return traffic is only allowed for flows the inside started', () => {
	netRouter.applyForwarding('enp3s0', ['wg-mesh']);

	assert.ok(issued('-A FORWARD -i wg-mesh -o enp3s0 -j ACCEPT').length);
	// The internet must not be able to open connections into the mesh.
	const inbound = issued('-A FORWARD -i enp3s0 -o wg-mesh');
	assert.ok(inbound.length);
	assert.ok(inbound[0].includes('--state RELATED,ESTABLISHED'));
});

test('nothing is masqueraded when there is no uplink', () => {
	const res = netRouter.applyForwarding(null, ['wg-mesh']);
	assert.strictEqual(res.skipped, 'no WAN interface');
	assert.strictEqual(issued('MASQUERADE').length, 0);
});

// Reconcile runs at boot, on every roster change, and on a timer. Without the
// -C guard each pass would stack another identical rule.
test('an existing rule is not added again', () => {
	responses['iptables -t nat -C POSTROUTING -o enp3s0 -j MASQUERADE'] = '';
	netRouter.applyForwarding('enp3s0', []);
	assert.strictEqual(issued('-A POSTROUTING -o enp3s0 -j MASQUERADE').length, 0);
});

test('NETMAP maps the shadow range both ways and claims it locally', () => {
	netRouter.applyNetmap('wg-mesh', '10.2.168.0/24', '192.168.1.0/24');

	// Inbound: a peer addresses the shadow, we rewrite to the real LAN.
	assert.ok(issued('-A PREROUTING -i wg-mesh -d 10.2.168.0/24 -j NETMAP --to 192.168.1.0/24').length);
	// Outbound: a LAN host appears to the mesh as its shadow.
	assert.ok(issued('-A POSTROUTING -o wg-mesh -s 192.168.1.0/24 -j NETMAP --to 10.2.168.0/24').length);
	// Without claiming the range locally the box never sees those packets at
	// all, so PREROUTING never fires.
	assert.ok(issued('ip route add local 10.2.168.0/24 dev lo').length);
	// And LAN hosts need a way onto the mesh.
	assert.ok(issued('-A POSTROUTING -s 192.168.1.0/24 -o wg-mesh -j MASQUERADE').length);
});

test('a local route already present is not re-added', () => {
	responses['ip route show table local 10.2.168.0/24'] = 'local 10.2.168.0/24 dev lo scope host';
	netRouter.applyNetmap('wg-mesh', '10.2.168.0/24', '192.168.1.0/24');
	assert.strictEqual(issued('ip route add local').length, 0);
});

test('removing a mapping tears down every rule it added', () => {
	// -C succeeds once then fails, so each rule is deleted exactly once.
	let seen = new Set();
	responses = new Proxy({}, {
		get: (_t, key) => {
			if (typeof key !== 'string' || !key.includes(' -C ')) return undefined;
			if (seen.has(key)) return undefined;
			seen.add(key);
			return '';
		}
	});

	netRouter.removeNetmap('wg-mesh', '10.2.168.0/24', '192.168.1.0/24');
	assert.ok(issued('-D PREROUTING -i wg-mesh -d 10.2.168.0/24').length);
	assert.ok(issued('-D POSTROUTING -o wg-mesh -s 192.168.1.0/24').length);
	assert.ok(issued('ip route del local 10.2.168.0/24 dev lo').length);
});

// This is the failure that shipped: applyForwarding threw when iptables was
// absent, and the caller did not guard it, so everything after it -- NETMAP
// and the whole exit configuration -- was silently skipped.
test('a missing iptables reports a limitation instead of throwing', () => {
	responses['iptables --version'] = missing();
	responses['sysctl --version'] = missing();

	const res = netRouter.applyForwarding('enp3s0', ['wg-mesh']);
	assert.strictEqual(res.skipped, 'iptables not available');
	assert.deepStrictEqual(netRouter.missingTools(), ['iptables', 'sysctl']);
	// And it must not have tried to add anything.
	assert.strictEqual(issued('-A POSTROUTING').length, 0);
});

test('NETMAP reports unavailable rather than throwing when iptables is absent', () => {
	responses['iptables --version'] = missing();
	assert.doesNotThrow(() => netRouter.applyNetmap('wg-mesh', '10.2.168.0/24', '192.168.1.0/24'));
	assert.strictEqual(netRouter.netmapAvailable(), false);
});

// The knobs are just files, so a missing binary is not the end of it -- but a
// read-only /proc/sys (every default container) is.
test('sysctls fall back to writing /proc/sys when the binary is missing', () => {
	responses['sysctl --version'] = missing();
	responses['sysctl -w net.ipv4.ip_forward=1'] = missing();
	netRouter.applySysctls([]);
	assert.ok(issued('/proc/sys/net/ipv4/ip_forward').length, 'expected a direct /proc/sys write');
});

test('the uplink is detected from the default route', () => {
	responses['ip -o route show default'] = 'default via 192.168.1.1 dev enp3s0 proto dhcp metric 100\n';
	assert.strictEqual(netRouter.detectWanInterface(), 'enp3s0');
});

test('a host with no default route reports no uplink', () => {
	responses['ip -o route show default'] = '';
	assert.strictEqual(netRouter.detectWanInterface(), null);
});

test('a kernel without the NETMAP target is detected', () => {
	responses['iptables -t nat -C POSTROUTING -s 192.0.2.0/24 -j NETMAP --to 198.51.100.0/24'] =
		Object.assign(new Error('bad target'), { stderr: Buffer.from('iptables: No chain/target/match by that name.') });
	assert.strictEqual(netRouter.netmapAvailable(), false);
});

test('a kernel WITH NETMAP is not mistaken for a missing one', () => {
	// The probe rule does not exist, so -C fails -- but with "Bad rule", which
	// means the target parsed fine and only the rule was absent.
	responses['iptables -t nat -C POSTROUTING -s 192.0.2.0/24 -j NETMAP --to 198.51.100.0/24'] =
		Object.assign(new Error('no rule'), { stderr: Buffer.from('iptables: Bad rule (does a matching rule exist in that chain?)') });
	assert.strictEqual(netRouter.netmapAvailable(), true);
});
