'use strict';

// Exit selection.
//
// The rule that shapes all of this: WireGuard's AllowedIPs is one trie per
// interface, so only one peer can own 0.0.0.0/0, and WireGuard routes on
// DESTINATION while ignoring the kernel nexthop. Multiple exits are therefore
// only expressible as multiple interfaces, with policy routing choosing
// between them.

const { test } = require('node:test');
const assert = require('node:assert');

const { planExits, ifaceFor, tableFor, TABLE_BASE, RULE_PRIORITY_BASE } = require('../../services/exit_router');

// Parsing `ip rule show` back into structured rules is what lets a test assert
// that a rule is INSTALLED rather than merely planned -- the distinction that
// let a completely unapplied exit configuration pass the end-to-end suite.
const RULE_OUTPUT = [
	'0:\tfrom all lookup local',
	// The kernel prints a /32 rule WITHOUT the prefix -- exactly as `ip rule
	// show` returns it, which is what made an otherwise-correct end-to-end
	// assertion fail.
	`${RULE_PRIORITY_BASE + 1}:\tfrom 10.2.128.1 lookup ${TABLE_BASE + 1}`,
	`${RULE_PRIORITY_BASE + 5}:\tfrom 10.2.128.9/32 lookup ${TABLE_BASE + 5}`,
	'32766:\tfrom all lookup main',
	'100:\tfrom 192.168.1.0/24 lookup 99'
].join('\n');

const site = (id, over = {}) => ({
	siteId: id, slug: `site-${id}`,
	gatewayPublicKey: `key-${id}`.padEnd(44, 'x'),
	gatewayEndpoint: `s${id}.example:51820`,
	exitOpen: true,
	...over
});

const client = (ip, exitSiteId) => ({ uid: 'alice', name: 'dev', assignedIp: ip, publicKey: 'k'.repeat(44), exitSiteId });

const ROSTER = [site(1), site(5), site(6)];

test('a device with no exit produces no interface and no rule', () => {
	const plan = planExits([client('10.2.128.1', null)], ROSTER, 2);
	assert.deepStrictEqual(plan.exits, []);
	assert.deepStrictEqual(plan.rules, []);
});

test('each chosen exit gets its own interface and table', () => {
	const plan = planExits([client('10.2.128.1', 5), client('10.2.128.2', 6)], ROSTER, 2);

	assert.deepStrictEqual(plan.exits.map((e) => e.iface), ['wg-exit-5', 'wg-exit-6']);
	assert.deepStrictEqual(plan.exits.map((e) => e.table), [TABLE_BASE + 5, TABLE_BASE + 6]);
	assert.strictEqual(ifaceFor(5), 'wg-exit-5');
	assert.strictEqual(tableFor(5), TABLE_BASE + 5);
});

// The whole reason for the design: two peers on one interface both claiming
// the default route would leave exactly one working exit.
test('every exit peer owns the default route on its OWN interface', () => {
	const plan = planExits([client('10.2.128.1', 5), client('10.2.128.2', 6)], ROSTER, 2);
	for (const exit of plan.exits) {
		assert.deepStrictEqual(exit.allowedIPs, ['0.0.0.0/0', '::/0']);
	}
	// ...and no two exits share an interface.
	assert.strictEqual(new Set(plan.exits.map((e) => e.iface)).size, plan.exits.length);
});

test('devices sharing an exit share one interface but get their own rule', () => {
	const plan = planExits([client('10.2.128.1', 5), client('10.2.128.2', 5)], ROSTER, 2);

	assert.strictEqual(plan.exits.length, 1);
	assert.strictEqual(plan.rules.length, 2);
	assert.deepStrictEqual(plan.rules.map((r) => r.from), ['10.2.128.1/32', '10.2.128.2/32']);
	// Same table for both -- the interface is shared, the selection is not.
	assert.deepStrictEqual(plan.rules.map((r) => r.table), [TABLE_BASE + 5, TABLE_BASE + 5]);
});

// Per-client rules rather than per-range are what let the tray change an exit
// without renumbering the device or reissuing its config.
test('a rule selects exactly one device by address', () => {
	const plan = planExits([client('10.2.128.7', 5)], ROSTER, 2);
	assert.deepStrictEqual(plan.rules[0], {
		from: '10.2.128.7/32', table: TABLE_BASE + 5, priority: RULE_PRIORITY_BASE + 5, exitSiteId: 5
	});
});

test('rule priorities stay below the kernel main-table rule', () => {
	const plan = planExits([client('10.2.128.1', 254)], [site(254)], 2);
	// 32766 is the kernel's `from all lookup main`. A rule above it would
	// never be consulted for the client it names.
	assert.ok(plan.rules[0].priority < 32766);
	assert.ok(plan.rules[0].priority > 0);
});

test('choosing this site as the exit means local breakout, not a tunnel to itself', () => {
	const plan = planExits([client('10.2.128.1', 2)], [...ROSTER, site(2)], 2);
	assert.deepStrictEqual(plan.exits, []);
	assert.deepStrictEqual(plan.rules, []);
});

// "Your VPN stopped working" is otherwise indistinguishable from a dead
// tunnel, so each unusable choice is reported with its reason.
test('an exit that is not in the roster is reported, not silently dropped', () => {
	const plan = planExits([client('10.2.128.1', 9)], ROSTER, 2);
	assert.deepStrictEqual(plan.exits, []);
	assert.strictEqual(plan.unusable.length, 1);
	assert.match(plan.unusable[0].reason, /no such site/);
	assert.strictEqual(plan.unusable[0].client, '10.2.128.1');
});

test('an exit whose gateway has not published a key is reported', () => {
	const plan = planExits([client('10.2.128.1', 5)], [site(5, { gatewayPublicKey: '' })], 2);
	assert.strictEqual(plan.exits.length, 0);
	assert.match(plan.unusable[0].reason, /has not published a public key/);
});

// An exit must be dialable: it is reached over its own interface, not through
// the mesh, so the hub cannot stand in for a missing endpoint.
test('an exit with no reachable endpoint is reported', () => {
	const plan = planExits([client('10.2.128.1', 5)], [site(5, { gatewayEndpoint: '' })], 2);
	assert.strictEqual(plan.exits.length, 0);
	assert.match(plan.unusable[0].reason, /no reachable endpoint/);
});

test('one unusable exit does not stop a usable one', () => {
	const plan = planExits([client('10.2.128.1', 9), client('10.2.128.2', 5)], ROSTER, 2);
	assert.strictEqual(plan.exits.length, 1);
	assert.strictEqual(plan.exits[0].siteId, 5);
	assert.strictEqual(plan.rules.length, 1);
	assert.strictEqual(plan.unusable.length, 1);
});

test('exit peers keep alive, since the gateway always dials them', () => {
	const plan = planExits([client('10.2.128.1', 5)], ROSTER, 2);
	assert.strictEqual(plan.exits[0].keepalive, 25);
	assert.strictEqual(plan.exits[0].endpoint, 's5.example:51820');
});

test('no devices means no exit configuration at all', () => {
	const plan = planExits([], ROSTER, 2);
	assert.deepStrictEqual(plan.exits, []);
	assert.deepStrictEqual(plan.rules, []);
	assert.deepStrictEqual(plan.unusable, []);
});

test('managed rules are read back from the kernel, ignoring everyone else\'s', () => {
	const exitRouter = require('../../services/exit_router');
	const netRouter = require('../../utils/net_router');
	const original = netRouter._tryRun;
	// listManagedRules goes through net_router's runner; stub just that.
	require('../../utils/net_router')._tryRun = () => ({ ok: true, out: RULE_OUTPUT });
	try {
		const rules = exitRouter.listManagedRules();
		// Normalised back to the form they were added in.
		assert.deepStrictEqual(rules.map((r) => r.from), ['10.2.128.1/32', '10.2.128.9/32']);
		assert.strictEqual(Number(rules[0].table), TABLE_BASE + 1);
		// The kernel's own rules and an operator's rule at priority 100 are not
		// ours to report or to delete.
		assert.ok(!rules.some((r) => r.from === 'all'));
		assert.ok(!rules.some((r) => r.from === '192.168.1.0/24'));
	} finally {
		require('../../utils/net_router')._tryRun = original;
	}
});
