'use strict';

// Which directory hosts may a user reach, and how do we dial them?
//
// v1 resolution (see directory_spec.md §9.2 in sso-manager-node): the SSO's
// /api/discovery/me only answers for the API token's own user, and /graph
// omits ResourceGroup links — so we combine the user's LDAP groups (queried
// directly) with per-group resource lookups:
//
//   1. LDAP: groups the user's DN is a member of
//   2. SSO:  GET /api/discovery/resources?group=<cn>  per group (ApiToken)
//   3. union, keep kind === 'host'
//
// Results are cached per-uid for a short TTL — the TUI picker and the
// username-grammar path share the cache. Dependency-injected fetch/ldap for
// unit testing.

const conf = require('@simpleworkjs/conf');
const userLdap = require('../models/user_ldap');

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // uid -> {at, hosts}

async function fetchResourcesByGroup(group, { fetchImpl = fetch } = {}) {
	const sso = conf.sso || {};
	const url = `${sso.url}/api/discovery/resources?group=${encodeURIComponent(group)}`;
	const res = await fetchImpl(url, {
		headers: { Authorization: `Bearer ${sso.apiToken}` },
	});
	if (!res.ok) throw new Error(`directory query failed (${res.status}) for group ${group}`);
	const data = await res.json();
	return (data && data.results) || [];
}

async function accessibleHosts(user, { fetchImpl = fetch, ldap = userLdap } = {}) {
	const hit = cache.get(user.uid);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.hosts;

	const groups = await ldap.getGroups(user.dn);

	const seen = new Map();
	for (const cn of groups) {
		let resources;
		try {
			resources = await fetchResourcesByGroup(cn, { fetchImpl });
		} catch (error) {
			// One bad group must not hide the rest; the SSO being down
			// surfaces as an empty list + log line, not a crash.
			console.error(`[access] ${error.message}`);
			continue;
		}
		for (const r of resources) {
			if (r.kind === 'host' && !seen.has(r.id)) seen.set(r.id, r);
		}
	}

	const hosts = [...seen.values()];
	cache.set(user.uid, { at: Date.now(), hosts });
	return hosts;
}

function clearCache(uid) {
	if (uid) cache.delete(uid);
	else cache.clear();
}

module.exports = { accessibleHosts, clearCache, fetchResourcesByGroup };
