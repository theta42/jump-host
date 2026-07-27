'use strict';

// Host discovery — SSO Manager API in production, ORM-backed inventory in
// standalone mode. Both export the same interface:
//   accessibleHosts(user) -> [host resources]
//   clearCache(uid?)      -> void

const conf = require('@simpleworkjs/conf');

if (conf.standalone && conf.standalone.enabled) {
	// Standalone mode: use the ORM-backed host inventory. Every host is
	// accessible to every user, so allHosts and accessibleHosts coincide.
	const { accessibleHosts } = require('./hosts_file');
	module.exports = { accessibleHosts, allHosts: () => accessibleHosts(), clearCache: () => {} };
} else {
	// Production mode: LDAP groups + SSO API (unchanged).

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

	const { createDirectoryClient } = require('@simpleworkjs/directory-schema');
	const userLdap = require('../models/user_ldap');

	const CACHE_TTL_MS = 30 * 1000;
	const cache = new Map(); // uid -> {at, hosts}

	// Build a directory client bound to conf.sso. fetchImpl is injectable so the
	// unit tests can stub the transport; the shared client validates the
	// `{ results }` envelope on every call (turns the old bare-array drift into a
	// thrown error instead of a silent `[]`).
	function directoryClient({ fetchImpl = fetch } = {}) {
		const sso = conf.sso || {};
		return createDirectoryClient({ baseUrl: sso.url, apiToken: sso.apiToken, fetch: fetchImpl });
	}

	async function fetchResourcesByGroup(group, { fetchImpl = fetch } = {}) {
		return directoryClient({ fetchImpl }).getResourcesByGroup(group);
	}

	// Every host in the inventory, unfiltered — for admins (the web UI's own
	// account is already gated by requireAdmin before this is ever called).
	async function allHosts({ fetchImpl = fetch } = {}) {
		const resources = await directoryClient({ fetchImpl }).getResourcesByGroup(undefined, { kind: 'host' });
		return resources.filter(r => r.kind === 'host');
	}

	async function accessibleHosts(user, { fetchImpl = fetch, ldap = userLdap } = {}) {
		const hit = cache.get(user.uid);
		if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.hosts;

		// The SSH path passes an LDAP user ({dn, uid, ...}) with no .groups, so we
		// look them up; the web UI already has the session's OIDC groups claim
		// and passes it directly, skipping a redundant LDAP round-trip.
		const groups = user.groups || await ldap.getGroups(user.dn);

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

	module.exports = { accessibleHosts, allHosts, clearCache, fetchResourcesByGroup };
}
