'use strict';

// A stand-in for theta-directory's mesh API, for the three-site end-to-end
// test. It is deliberately dumb: it holds a roster in memory, learns each
// gateway's public key when that gateway publishes it, and serves the three
// endpoints a gateway reads.
//
// Each site in a real cluster has its OWN directory, and a gateway's site id
// comes from the directory it is talking to -- so this serves one listener per
// site rather than one shared endpoint. That is what makes "which site am I"
// answerable without the gateway being told.
//
// The addressing rules are duplicated here on purpose. If this file imported
// the real ones, the test could not catch the two sides drifting apart, which
// is one of the things it exists to check.

const http = require('http');

const SITES = [
	{ siteId: 1, slug: 'hub', isHub: true, exitOpen: true, country: 'US', city: 'Ashburn', endpointHost: 'gateway-1' },
	{ siteId: 2, slug: 'office', isHub: false, exitOpen: false, lan168: '192.168.1.0/24', dnsHost: '192.168.1.1', endpointHost: 'gateway-2' },
	{ siteId: 3, slug: 'home', isHub: false, exitOpen: false, lan168: '192.168.1.0/24', endpointHost: 'gateway-3' }
];

// Devices, keyed by the site they belong to. Their public keys are fixed so the
// test can assert on them; nothing dials these, they only have to appear as
// peers with the right AllowedIPs.
const CLIENTS = {
	2: [{ id: 'c1', uid: 'alice', name: 'laptop', publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', assignedIp: '10.2.128.1', exitSiteId: 1 }],
	3: []
};

const roster = new Map(SITES.map((s) => [s.siteId, {
	...s,
	gatewayPublicKey: '',
	gatewayEndpoint: '',
	lan172: '',
	name: s.slug
}]));

const peerAllowedIps = (id) => [`172.24.0.${id}/32`, `10.${id}.0.0/16`];
const hubAllowedIps = () => ['10.0.0.0/8', '172.24.0.0/16'];

function peersFor(localSiteId) {
	const peers = [];
	for (const site of roster.values()) {
		if (site.siteId === localSiteId) continue;
		if (!site.gatewayPublicKey) continue;
		peers.push({
			siteId: site.siteId,
			slug: site.slug,
			publicKey: site.gatewayPublicKey,
			endpoint: site.gatewayEndpoint,
			isHub: !!site.isHub,
			allowedIps: site.isHub
				? [...hubAllowedIps(), ...peerAllowedIps(site.siteId)]
				: peerAllowedIps(site.siteId)
		});
	}
	return peers;
}

function serveSite(localSiteId, port) {
	const server = http.createServer((req, res) => {
		const send = (code, body) => {
			res.writeHead(code, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		const url = req.url.split('?')[0];

		if (req.method === 'PUT' && url === '/api/mesh/self') {
			let body = '';
			req.on('data', (c) => { body += c; });
			req.on('end', () => {
				let payload = {};
				try { payload = JSON.parse(body || '{}'); } catch (e) { /* ignore */ }
				const site = roster.get(localSiteId);
				// A gateway publishes only its own identity; it cannot name a
				// site, exactly as the real API works.
				if (payload.gatewayPublicKey) site.gatewayPublicKey = payload.gatewayPublicKey;
				if (payload.gatewayEndpoint) site.gatewayEndpoint = payload.gatewayEndpoint;
				console.log(`[fake-directory:${localSiteId}] published key=${(site.gatewayPublicKey || '').slice(0, 8)}… endpoint=${site.gatewayEndpoint}`);
				send(200, { status: 'ok', site });
			});
			return;
		}

		if (url === '/api/mesh/peers') {
			return send(200, {
				status: 'ok',
				localSiteId,
				hubSiteId: 1,
				peers: peersFor(localSiteId)
			});
		}

		if (url === '/api/mesh/site-clients') {
			return send(200, { status: 'ok', localSiteId, clients: CLIENTS[localSiteId] || [] });
		}

		if (url === '/api/mesh/roster') {
			return send(200, {
				status: 'ok',
				localSiteId,
				hubSiteId: 1,
				sites: [...roster.values()],
				addressing: { maxSiteId: 254, softLimit: 32, shadowSlots: [168, 172] }
			});
		}

		// Lets the test observe what every gateway has published, from one place.
		if (url === '/_roster') return send(200, { sites: [...roster.values()] });

		send(404, { status: 'error', message: 'not found' });
	});
	server.listen(port, '0.0.0.0', () => console.log(`[fake-directory] site ${localSiteId} on ${port}`));
}

// One listener per site: 4001, 4002, 4003.
for (const site of SITES) serveSite(site.siteId, 4000 + site.siteId);
