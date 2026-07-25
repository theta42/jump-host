'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { accessibleHosts, clearCache } = require('../../utils/access');

function stubLdap(groups) {
	return { getGroups: async () => groups };
}

function stubFetch(byGroup) {
	return async (url) => {
		const cn = decodeURIComponent(url.split('group=')[1]);
		return { ok: true, json: async () => ({ results: byGroup[cn] || [] }) };
	};
}

test('unions hosts across groups, dedupes, drops non-hosts', async () => {
	clearCache();
	const user = { uid: 'alice', dn: 'uid=alice,ou=people,dc=x' };
	const fetchImpl = stubFetch({
		host_web01_access: [
			{ id: '1', kind: 'host', slug: 'host_web01' },
			{ id: '9', kind: 'service', slug: 'app_gitea' }, // dropped: not a host
		],
		host_db_access: [
			{ id: '1', kind: 'host', slug: 'host_web01' }, // dupe by id
			{ id: '2', kind: 'host', slug: 'host_db' },
		],
	});
	const hosts = await accessibleHosts(user, { fetchImpl, ldap: stubLdap(['host_web01_access', 'host_db_access']) });
	assert.deepStrictEqual(hosts.map((h) => h.id).sort(), ['1', '2']);
});

test('a failing group query does not sink the rest', async () => {
	clearCache();
	const user = { uid: 'bob', dn: 'uid=bob,ou=people,dc=x' };
	const fetchImpl = async (url) => {
		if (url.includes('bad')) return { ok: false, status: 500 };
		return { ok: true, json: async () => ({ results: [{ id: '3', kind: 'host', slug: 'host_ok' }] }) };
	};
	const hosts = await accessibleHosts(user, { fetchImpl, ldap: stubLdap(['bad_access', 'good_access']) });
	assert.deepStrictEqual(hosts.map((h) => h.id), ['3']);
});

test('caches per uid', async () => {
	clearCache();
	let calls = 0;
	const user = { uid: 'cara', dn: 'd' };
	const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ results: [] }) }; };
	const ldap = { getGroups: async () => ['g1'] };
	await accessibleHosts(user, { fetchImpl, ldap });
	await accessibleHosts(user, { fetchImpl, ldap });
	assert.strictEqual(calls, 1);
});

test('a bare-array response (envelope drift) is treated as a failed group, not silently []', async () => {
	clearCache();
	const user = { uid: 'dave', dn: 'd' };
	// drift shape: a bare array instead of { results: [...] }. The shared client
	// throws DirectoryEnvelopeViolation; access.js must catch + continue, so a
	// good group alongside still yields its hosts.
	const fetchImpl = async (url) => {
		if (url.includes('drift')) return { ok: true, json: async () => [{ id: '7', kind: 'host' }] };
		return { ok: true, json: async () => ({ results: [{ id: '8', kind: 'host' }] }) };
	};
	const hosts = await accessibleHosts(user, { fetchImpl, ldap: stubLdap(['drift_access', 'good_access']) });
	assert.deepStrictEqual(hosts.map((h) => h.id), ['8']);
});
