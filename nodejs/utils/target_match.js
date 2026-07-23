'use strict';

// Match a requested target string against the list of directory host
// resources the user may access (from utils/access.js). Matching order:
//
//   1. exact slug            (host_web01)
//   2. host_-prefixed slug   (web01 -> host_web01)
//   3. exact name            (the directory display name, case-insensitive)
//   4. metadata.ip exact
//   5. metadata.address hostname exact (with or without scheme)
//
// A raw IPv4 target that matches no accessible host is allowed through only
// when allowRawIPs is set (the caller audits it as such); anything else that
// doesn't match is a no-access/no-such-target denial — the caller cannot
// tell those apart (by design: don't leak the inventory to unauthorized
// users).
//
// Returns { host, raw } — `host` is the matched resource (null for a
// permitted raw IP), `raw` is the literal address to dial when host is null.
// Throws { code: 'no-such-target' } when nothing matches.

const { isIPv4 } = require('./username_grammar');

function addrHost(address) {
	if (!address) return null;
	try {
		return new URL(address.includes('://') ? address : `ssh://${address}`).hostname;
	} catch (_) {
		return address;
	}
}

function matchTarget(target, hosts, { allowRawIPs = false } = {}) {
	const t = String(target).toLowerCase();

	const bySlug = hosts.find((h) => h.slug && h.slug.toLowerCase() === t);
	if (bySlug) return { host: bySlug, raw: null };

	const byPrefixed = hosts.find((h) => h.slug && h.slug.toLowerCase() === `host_${t}`);
	if (byPrefixed) return { host: byPrefixed, raw: null };

	const byName = hosts.find((h) => h.name && h.name.toLowerCase() === t);
	if (byName) return { host: byName, raw: null };

	const byIp = hosts.find((h) => h.metadata && h.metadata.ip === target);
	if (byIp) return { host: byIp, raw: null };

	const byAddr = hosts.find((h) => {
		const a = addrHost(h.metadata && h.metadata.address);
		return a && a.toLowerCase() === t;
	});
	if (byAddr) return { host: byAddr, raw: null };

	if (isIPv4(target) && allowRawIPs) return { host: null, raw: target };

	const err = new Error(`No accessible host matches '${target}'`);
	err.code = 'no-such-target';
	throw err;
}

// Resolve the address/port to dial for a matched host resource.
function hostEndpoint(host, defaultPort = 22) {
	const md = host.metadata || {};
	const address = md.ip || addrHost(md.address) || null;
	const port = Number(md.sshPort) || defaultPort;
	return { address, port };
}

module.exports = { matchTarget, hostEndpoint };
