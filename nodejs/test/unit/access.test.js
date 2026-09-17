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

// REPLACES 'a failing access query returns empty list without throwing'.
//
// That assertion encoded the bug. Returning [] makes the claim "you have
// access to nothing", which is a different statement from "I could not find
// out" -- and every caller acted on the first one. resolveAndConnect() wraps
// this in `.catch(() => throw fail('directory-unreachable'))` and the TUI path
// has its own try/catch, and BOTH were unreachable: an outage produced an
// empty host list, matchTarget() matched nothing, and the user was told "no
// host you can access matches that target". `directory-unreachable` was
// defined in reasonMessage() and could never fire.
//
// Still fails closed -- an unreachable directory grants nothing -- but it now
// says which of the two it is, to the user and to the audit log.
test('an unreachable directory throws rather than claiming no access', async () => {
	clearCache();
	const user = { uid: 'bob', dn: 'uid=bob,ou=people,dc=x' };
	const fetchImpl = async () => ({ ok: false, status: 500 });
	await assert.rejects(
		() => accessibleHosts(user, { fetchImpl }),
		(err) => err.code === 'directory-unreachable',
	);
});

// A failed lookup written into the cache locks the user out for the full TTL
// even once the directory is back, and a retry inside that window reads the
// cached empty instead of re-asking -- so one blip became 30 seconds of denial
// that retrying could not shorten.
test('a failed lookup is not cached', async () => {
	clearCache();
	const user = { uid: 'carol', dn: 'c' };
	let calls = 0;
	const failing = async () => { calls++; return { ok: false, status: 503 }; };
	await assert.rejects(() => accessibleHosts(user, { fetchImpl: failing }));
	assert.strictEqual(calls, 1);

	// Immediately afterwards, well inside the 30s TTL: the directory is back,
	// and the user must not still be locked out.
	const recovered = async () => ({ ok: true, json: async () => ({ results: [
		{ id: '1', kind: 'host', slug: 'host_web01' },
	] }) });
	const hosts = await accessibleHosts(user, { fetchImpl: recovered });
	assert.deepStrictEqual(hosts.map((h) => h.id), ['1']);
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

test('a bare-array response (envelope drift) is reported, not silently empty', async () => {
	clearCache();
	const user = { uid: 'dave', dn: 'd' };
	// drift shape: a bare array instead of { results: [...] }. The shared client
	// throws DirectoryEnvelopeViolation, which is exactly the class of fault
	// that must not be flattened into "this user has no hosts" -- a directory
	// answering in the wrong shape is a directory this side cannot read.
	const fetchImpl = async () => {
		return { ok: true, json: async () => [{ id: '7', kind: 'host' }] };
	};
	await assert.rejects(
		() => accessibleHosts(user, { fetchImpl }),
		(err) => err.code === 'directory-unreachable',
	);
});

// The admin view and the user view must report the same fault the same way,
// or an operator sees a 500 on one page and a 503 on the other for one outage.
test('allHosts tags an unreachable directory the same way', async () => {
	clearCache();
	const fetchImpl = async () => ({ ok: false, status: 502 });
	await assert.rejects(
		() => allHosts({ fetchImpl }),
		(err) => err.code === 'directory-unreachable',
	);
});
