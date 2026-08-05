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
	// We use the SSO's machine-aware /api/discovery/access/:uid endpoint,
	// which evaluates the user's groups server-side and returns their complete
	// access projection in one call.
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
	//
	// "In the catalog" is the same predicate the SSO's own Directory listing
	// applies (sso-manager-node routes/api_directory_admin.js GET /resources):
	// a resource that was auto-discovered and never promoted is NOT catalog
	// content and must never be offered as a jump target. Discovery writes
	// `metadata.discovery_sources`; promoting sets `metadata.managed = true`.
	// Hosts created by hand carry no discovery_sources at all and stay in.
	//
	// The two copies of this rule have already drifted apart once (unpromoted
	// Proxmox VMs showing up in the picker); if a third consumer needs it,
	// hoist it into @simpleworkjs/directory-schema rather than copying again.
	function isCatalogHost(r) {
		if (!r || r.kind !== 'host') return false;
		const meta = r.metadata || {};
		if (meta.managed === true || meta.managed === 'true') return true;
		if (meta.managed === false || meta.managed === 'false') return false;
		const sources = meta.discovery_sources || [];
		const autoDiscovered = sources.length > 0 && !sources.includes('manual');
		return !autoDiscovered;
	}

	async function allHosts({ fetchImpl = fetch } = {}) {
		const resources = await directoryClient({ fetchImpl }).getResourcesByGroup(undefined, { kind: 'host' });
		return resources.filter(isCatalogHost);
	}

	async function accessibleHosts(user, { fetchImpl = fetch } = {}) {
		const hit = cache.get(user.uid);
		if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.hosts;

		let resources = [];
		try {
			resources = await directoryClient({ fetchImpl }).getAccess(user.uid);
		} catch (error) {
			console.error(`[access] ${error.message}`);
		}

		const hosts = resources.filter(isCatalogHost);
		cache.set(user.uid, { at: Date.now(), hosts });
		return hosts;
	}

	function clearCache(uid) {
		if (uid) cache.delete(uid);
		else cache.clear();
	}

	module.exports = { accessibleHosts, allHosts, clearCache, fetchResourcesByGroup };
}
