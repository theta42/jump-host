'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { accessibleHosts, allHosts, clearCache } = require('../../utils/access');

function stubLdap(groups) {
	return { getGroups: async () => groups };
}

function stubFetch(byUid) {
	return async (url) => {
		const uid = url.split('/access/')[1];
		return { ok: true, json: async () => ({ results: byUid[uid] || [] }) };
	};
}

test('drops non-hosts from access projection', async () => {
	clearCache();
	const user = { uid: 'alice', dn: 'uid=alice,ou=people,dc=x' };
	const fetchImpl = stubFetch({
		alice: [
			{ id: '1', kind: 'host', slug: 'host_web01' },
			{ id: '2', kind: 'host', slug: 'host_db' },
			{ id: '9', kind: 'service', slug: 'app_gitea' }, // dropped: not a host
		],
	});
	const hosts = await accessibleHosts(user, { fetchImpl });
	assert.deepStrictEqual(hosts.map((h) => h.id).sort(), ['1', '2']);
});

test('a failing access query returns empty list without throwing', async () => {
	clearCache();
	const user = { uid: 'bob', dn: 'uid=bob,ou=people,dc=x' };
	const fetchImpl = async () => ({ ok: false, status: 500 });
	const hosts = await accessibleHosts(user, { fetchImpl });
	assert.deepStrictEqual(hosts, []);
});

test('caches per uid', async () => {
	clearCache();
	let calls = 0;
	const user = { uid: 'cara', dn: 'd' };
	const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ results: [] }) }; };
	await accessibleHosts(user, { fetchImpl });
	await accessibleHosts(user, { fetchImpl });
	assert.strictEqual(calls, 1);
});

test('does not depend on user.groups or ldap.getGroups', async () => {
	clearCache();
	const user = { uid: 'erin' }; // no dn, no groups
	const fetchImpl = stubFetch({
		erin: [{ id: '5', kind: 'host', slug: 'host_web01' }],
	});
	const hosts = await accessibleHosts(user, { fetchImpl });
	assert.deepStrictEqual(hosts.map((h) => h.id), ['5']);
});

test('allHosts fetches the whole host inventory with no group filter', async () => {
	const fetchImpl = async (url) => {
		assert.ok(!url.includes('group='), 'must not filter by group');
		assert.ok(url.includes('kind=host'));
		return { ok: true, json: async () => ({ results: [
			{ id: '1', kind: 'host', slug: 'host_a' },
			{ id: '2', kind: 'host', slug: 'host_b' },
		] }) };
	};
	const hosts = await allHosts({ fetchImpl });
	assert.deepStrictEqual(hosts.map((h) => h.id).sort(), ['1', '2']);
});

// Only catalog content is a jump target. Discovery writes `discovery_sources`;
// promoting to the catalog sets `managed: true`. An unpromoted Proxmox VM was
// reaching the picker because the filter defaulted `managed`-less hosts to true.
test('drops auto-discovered hosts that were never promoted', async () => {
	clearCache();
	const user = { uid: 'frank', dn: 'd' };
	const fetchImpl = stubFetch({
		frank: [
			{ id: '1', kind: 'host', slug: 'host_web01' },                                          // hand-made: no discovery_sources
			{ id: '2', kind: 'host', slug: 'vm-101', metadata: { discovery_sources: ['proxmox'] } }, // discovered, unpromoted
			{ id: '3', kind: 'host', slug: 'vm-102', metadata: { discovery_sources: ['proxmox'], managed: true } }, // promoted
			{ id: '4', kind: 'host', slug: 'host_db', metadata: { discovery_sources: ['manual'] } }, // manual source counts as catalog
			{ id: '5', kind: 'host', slug: 'host_off', metadata: { managed: false } },               // explicitly out
		],
	});
	const hosts = await accessibleHosts(user, { fetchImpl });
	assert.deepStrictEqual(hosts.map((h) => h.id).sort(), ['1', '3', '4']);
});

test('a bare-array response (envelope drift) returns empty list', async () => {
	clearCache();
	const user = { uid: 'dave', dn: 'd' };
	// drift shape: a bare array instead of { results: [...] }. The shared client
	// throws DirectoryEnvelopeViolation; access.js must catch + continue.
	const fetchImpl = async () => {
		return { ok: true, json: async () => [{ id: '7', kind: 'host' }] };
	};
	const hosts = await accessibleHosts(user, { fetchImpl });
	assert.deepStrictEqual(hosts, []);
});
