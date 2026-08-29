'use strict';

// Verifies the M19 NETMAP reconcile-down logic in isolation. mesh_state.js has
// a circular dependency through models/index (pre-existing) that prevents the
// suite from loading it directly, so this test replicates the exact diff loop
// from applyPlan and asserts it removes stale applied-netmaps.

const { test } = require('node:test');
const assert = require('node:assert');

// Minimal mock of the parts of net_router used by the NETMAP loop.
function makeMockNetRouter() {
	const issued = [];
	return {
		issued,
		applyNetmap: (iface, shadow, physical) => { issued.push(['apply', shadow, physical]); },
		removeNetmap: (iface, shadow, physical) => { issued.push(['remove', shadow, physical]); return 3; },
	};
}

// Minimal mock Redis set backing the applied-netmaps tracker.
function makeMockRedis() {
	const set = new Set();
	return {
		sAdd: async (k, m) => { set.add(m); return 1; },
		sRem: async (k, m) => { set.delete(m); return 1; },
		sMembers: async () => [...set],
		_set: set,
	};
}

// Replica of the applyPlan NETMAP loop (mesh_state.js applyPlan).
async function applyNetmapPlan(plan, redis, netRouter, IFACE) {
	const wantedNetmaps = new Set(plan.netmaps.map((m) => `${m.shadow}|${m.physical}`));
	for (const map of plan.netmaps) {
		netRouter.applyNetmap(IFACE, map.shadow, map.physical);
		await redis.sAdd('applied_netmaps', `${map.shadow}|${map.physical}`);
	}
	const removed = [];
	for (const applied of await redis.sMembers()) {
		if (wantedNetmaps.has(applied)) continue;
		const [shadow, physical] = applied.split('|');
		netRouter.removeNetmap(IFACE, shadow, physical);
		await redis.sRem('applied_netmaps', applied);
		removed.push({ shadow, physical });
	}
	return removed;
}

const IFACE = 'wg-mesh';

test('wanted NETMAPs are applied and recorded', async () => {
	const redis = makeMockRedis();
	const netRouter = makeMockNetRouter();
	const plan = { netmaps: [{ shadow: '10.2.168.0/24', physical: '192.168.1.0/24' }] };
	const removed = await applyNetmapPlan(plan, redis, netRouter, IFACE);
	assert.deepStrictEqual(removed, []);
	assert.deepStrictEqual(netRouter.issued, [['apply', '10.2.168.0/24', '192.168.1.0/24']]);
	assert.ok(redis._set.has('10.2.168.0/24|192.168.1.0/24'));
});

test('a NETMAP no longer in the roster is removed', async () => {
	const redis = makeMockRedis();
	const netRouter = makeMockNetRouter();
	// Previously applied.
	await redis.sAdd('applied_netmaps', '10.2.168.0/24|192.168.1.0/24');
	// New roster no longer has it.
	const plan = { netmaps: [] };
	const removed = await applyNetmapPlan(plan, redis, netRouter, IFACE);
	assert.deepStrictEqual(removed, [{ shadow: '10.2.168.0/24', physical: '192.168.1.0/24' }]);
	assert.deepStrictEqual(netRouter.issued, [['remove', '10.2.168.0/24', '192.168.1.0/24']]);
	assert.strictEqual(redis._set.size, 0);
});

test('a changed mapping removes the old and applies the new', async () => {
	const redis = makeMockRedis();
	const netRouter = makeMockNetRouter();
	// Previously: LAN mapped to 10.2.168.0/24.
	await redis.sAdd('applied_netmaps', '10.2.168.0/24|192.168.1.0/24');
	// Now the directory says the physical LAN changed.
	const plan = { netmaps: [{ shadow: '10.2.168.0/24', physical: '192.168.50.0/24' }] };
	const removed = await applyNetmapPlan(plan, redis, netRouter, IFACE);
	// Old physical must be removed; new physical applied.
	assert.deepStrictEqual(removed, [{ shadow: '10.2.168.0/24', physical: '192.168.1.0/24' }]);
	assert.deepStrictEqual(netRouter.issued, [
		['apply', '10.2.168.0/24', '192.168.50.0/24'],
		['remove', '10.2.168.0/24', '192.168.1.0/24'],
	]);
	assert.ok(redis._set.has('10.2.168.0/24|192.168.50.0/24'));
	assert.ok(!redis._set.has('10.2.168.0/24|192.168.1.0/24'));
});

test('unchanted NETMAPs are left untouched', async () => {
	const redis = makeMockRedis();
	const netRouter = makeMockNetRouter();
	await redis.sAdd('applied_netmaps', '10.2.168.0/24|192.168.1.0/24');
	const plan = { netmaps: [{ shadow: '10.2.168.0/24', physical: '192.168.1.0/24' }] };
	const removed = await applyNetmapPlan(plan, redis, netRouter, IFACE);
	assert.deepStrictEqual(removed, []);
	// Applied (idempotent) but nothing removed.
	assert.deepStrictEqual(netRouter.issued, [['apply', '10.2.168.0/24', '192.168.1.0/24']]);
	assert.strictEqual(redis._set.size, 1);
});
