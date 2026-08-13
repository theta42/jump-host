'use strict';

// mDNS local-discovery announcer (MULTI_SITE_SPEC.md Appendix B). Advertises
// this site's local presence so an agent on the same LAN segment (with
// prefer_local_directory enabled -- see theta-agent's local_discovery.go)
// can skip the relay/WAN path and talk to the local instance directly, and
// so a roaming agent or a fresh install can discover which site (if any) it
// is physically at.
//
// What gets announced is deliberately just "which public hostnames does
// this site front, and at what local address" -- nothing about identity or
// trust. The listening side never weakens certificate validation based on
// this; it only ever changes DNS resolution (see the hard rule documented
// in theta-agent's local_discovery.go).

const os = require('os');

const SERVICE_TYPE = 'theta-suite'; // -> _theta-suite._tcp, matches theta-agent's mdnsServiceName

function announcedHosts() {
	return (process.env.THETA_LOCAL_DISCOVERY_HOSTS || '')
		.split(',')
		.map((h) => h.trim())
		.filter(Boolean);
}

// Container/VM bridge and veth interfaces never represent how another
// machine on the LAN reaches this host. Mirrors theta-agent's
// isVirtualInterfaceName (telemetry.go) -- same bug, same fix, different
// language: bonjour-service's Service.records() (dist/lib/service.js)
// builds an A/AAAA record from EVERY os.networkInterfaces() entry with no
// filtering at all, so on a host that also runs Docker (true of every
// theta-suite box -- theta-gateway runs on the host specifically so it can
// do this kind of networking, alongside the rest of the stack in
// containers), the announcement can just as easily resolve to a docker0/
// br-* bridge gateway address as to the real LAN IP.
const VIRTUAL_IFACE_PREFIXES = [
	'docker', 'br-', 'veth', 'cni', 'flannel', 'virbr', 'podman', 'tun', 'tap', 'lxcbr', 'vnet', 'wg',
];

function isVirtualInterfaceName(name) {
	const lower = String(name || '').toLowerCase();
	return VIRTUAL_IFACE_PREFIXES.some((p) => lower.startsWith(p));
}

// This host's real, LAN-reachable IPv4 addresses -- everything
// os.networkInterfaces() reports, minus loopback and virtual/bridge
// interfaces. Exported for the record-filtering patch below and for
// choosing the address advertised in the `directoryAddr` TXT field.
function realLanIPv4s() {
	const out = [];
	const ifaces = os.networkInterfaces();
	for (const [name, addrs] of Object.entries(ifaces)) {
		if (isVirtualInterfaceName(name)) continue;
		for (const addr of addrs || []) {
			if (addr.internal || addr.family !== 'IPv4') continue;
			out.push(addr.address);
		}
	}
	return out;
}

let bonjourInstance = null;
let publishedService = null;

async function startMdnsAnnounce() {
	const hosts = announcedHosts();
	if (hosts.length === 0) {
		console.log('[mdns-announce] THETA_LOCAL_DISCOVERY_HOSTS not set -- nothing to announce, skipping');
		return;
	}

	const lanIPs = realLanIPv4s();
	if (lanIPs.length === 0) {
		console.log('[mdns-announce] no real (non-virtual) LAN interface found -- announcing anyway, but the advertised address may be wrong.');
	}

	const { Bonjour } = require('bonjour-service');
	bonjourInstance = new Bonjour(undefined, (err) => {
		console.error('[mdns-announce] bonjour-service error:', err.message);
	});

	const port = Number(process.env.PORT) || 80;
	const directoryHost = process.env.THETA_LOCAL_DISCOVERY_DIRECTORY_HOST || hosts[0];
	const directoryAddr = lanIPs.length ? `${lanIPs[0]}:${port}` : '';

	publishedService = bonjourInstance.publish({
		name: `theta-suite-${process.env.SITE_SLUG || 'site'}`,
		type: SERVICE_TYPE,
		port,
		txt: {
			hosts: hosts.join(','),
			site: process.env.SITE_SLUG || '',
			// The directory's own public hostname, distinct from `hosts`
			// (which also carries the proxy/jump hostnames) -- lets a roaming
			// agent or a fresh install identify the directory specifically
			// without guessing which entry in `hosts` it is.
			directoryHost,
			// Explicit "<real LAN IP>:<port>" for the directory, computed the
			// same way `records()` is filtered below -- NOT left to whatever
			// address bonjour's own A-record auto-detection happens to pick.
			// A listener that trusts this over the raw mDNS response address
			// is immune to the docker-bridge-IP bug even if a future
			// bonjour-service version regresses the records() filter.
			directoryAddr,
			// theta-suite's own version (THETA_SUITE_VERSION, set by
			// setup.sh from `git describe --tags`), so a roaming agent or a
			// setup flow can tell what it's talking to before connecting.
			version: process.env.THETA_SUITE_VERSION || '',
		},
	});

	// bonjour-service has no config knob to filter which interfaces it
	// builds A/AAAA records from (see the comment on VIRTUAL_IFACE_PREFIXES
	// above) -- so filter its own records() output for OUR service instance
	// instead of forking the library. Re-computed on every call (not just at
	// publish time) so an interface that appears/disappears later (a VPN
	// connecting, a docker network being created) is picked up correctly.
	const originalRecords = publishedService.records.bind(publishedService);
	publishedService.records = function patchedRecords() {
		const virtualIPs = new Set();
		const ifaces = os.networkInterfaces();
		for (const [name, addrs] of Object.entries(ifaces)) {
			if (!isVirtualInterfaceName(name)) continue;
			for (const addr of addrs || []) virtualIPs.add(addr.address);
		}
		return originalRecords().filter((r) => !((r.type === 'A' || r.type === 'AAAA') && virtualIPs.has(r.data)));
	};

	console.log(`[mdns-announce] announcing on the local network: ${hosts.join(', ')} (directoryAddr=${directoryAddr || 'unknown'})`);
}

function stopMdnsAnnounce() {
	if (bonjourInstance) {
		bonjourInstance.destroy();
		bonjourInstance = null;
		publishedService = null;
	}
}

module.exports = { startMdnsAnnounce, stopMdnsAnnounce, isVirtualInterfaceName, realLanIPv4s };
