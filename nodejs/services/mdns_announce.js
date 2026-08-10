'use strict';

// mDNS local-discovery announcer (MULTI_SITE_SPEC.md Appendix B). Advertises
// this site's local presence so an agent on the same LAN segment (with
// prefer_local_directory enabled -- see theta-agent's local_discovery.go)
// can skip the relay/WAN path and talk to the local instance directly.
//
// What gets announced is deliberately just "which public hostnames does
// this site front, and at what local IP" -- nothing about identity or
// trust. The listening side never weakens certificate validation based on
// this; it only ever changes DNS resolution (see the hard rule documented
// in theta-agent's local_discovery.go).

const SERVICE_TYPE = 'theta-suite'; // -> _theta-suite._tcp, matches theta-agent's mdnsServiceName

function announcedHosts() {
	return (process.env.THETA_LOCAL_DISCOVERY_HOSTS || '')
		.split(',')
		.map((h) => h.trim())
		.filter(Boolean);
}

let bonjourInstance = null;
let publishedService = null;

async function startMdnsAnnounce() {
	const hosts = announcedHosts();
	if (hosts.length === 0) {
		console.log('[mdns-announce] THETA_LOCAL_DISCOVERY_HOSTS not set -- nothing to announce, skipping');
		return;
	}

	const { Bonjour } = require('bonjour-service');
	bonjourInstance = new Bonjour(undefined, (err) => {
		console.error('[mdns-announce] bonjour-service error:', err.message);
	});

	publishedService = bonjourInstance.publish({
		name: `theta-suite-${process.env.SITE_SLUG || 'site'}`,
		type: SERVICE_TYPE,
		port: Number(process.env.PORT) || 80,
		txt: { hosts: hosts.join(','), site: process.env.SITE_SLUG || '' }
	});

	console.log(`[mdns-announce] announcing on the local network: ${hosts.join(', ')}`);
}

function stopMdnsAnnounce() {
	if (bonjourInstance) {
		bonjourInstance.destroy();
		bonjourInstance = null;
		publishedService = null;
	}
}

module.exports = { startMdnsAnnounce, stopMdnsAnnounce };
