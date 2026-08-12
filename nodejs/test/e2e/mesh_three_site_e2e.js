'use strict';

// Three gateways, real WireGuard.
//
// THREE, not two, because the two-gateway case cannot expose the bugs that
// actually shipped:
//
//   * Applying the private key with `wg setconf` wiped every existing peer, so
//     the second peer deleted the first. With one peer each, nothing to delete.
//   * The joining side recorded a locally-invented index for its peer, which
//     agreed with reality by coincidence at two gateways and diverged at three.
//
// Both are structurally invisible below three sites, which is why this harness
// exists in this shape.

const GATEWAYS = [
	{ siteId: 1, url: process.env.GATEWAY_1_URL, pass: process.env.GATEWAY_1_ADMIN_PASS, slug: 'hub' },
	{ siteId: 2, url: process.env.GATEWAY_2_URL, pass: process.env.GATEWAY_2_ADMIN_PASS, slug: 'office' },
	{ siteId: 3, url: process.env.GATEWAY_3_URL, pass: process.env.GATEWAY_3_ADMIN_PASS, slug: 'home' }
];
const DIRECTORY = process.env.FAKE_DIRECTORY_URL || 'http://fake-directory:4001';

let failures = 0;
function check(name, ok, detail) {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` -- ${detail}` : ''}`);
	if (!ok) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(gw) {
	const resp = await fetch(`${gw.url}/api/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		// conf/base.js bootstraps `jumpadmin` as the local anti-lockout admin.
		body: JSON.stringify({ username: 'jumpadmin', password: gw.pass })
	});
	if (!resp.ok) throw new Error(`login at site ${gw.siteId}: HTTP ${resp.status}`);
	const data = await resp.json();
	return data.token || (data.data && data.data.token);
}

async function status(gw) {
	// jump-host's session auth reads `auth-token`, not an Authorization header.
	const resp = await fetch(`${gw.url}/api/mesh/status`, { headers: { 'auth-token': gw.token } });
	if (!resp.ok) throw new Error(`status at site ${gw.siteId}: HTTP ${resp.status}`);
	return resp.json();
}

async function waitFor(label, fn, timeoutMs = 90000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeoutMs) {
		try {
			const result = await fn();
			if (result) return result;
		} catch (err) { last = err.message; }
		await sleep(2000);
	}
	throw new Error(`timed out waiting for ${label}${last ? ` (last error: ${last})` : ''}`);
}

async function main() {
	console.log('# three-site mesh end-to-end\n');

	for (const gw of GATEWAYS) {
		gw.token = await waitFor(`site ${gw.siteId} to accept a login`, () => login(gw));
	}
	console.log('all three gateways reachable\n');

	// Every gateway publishes its identity, then builds peers for the other two.
	await waitFor('every gateway to publish its public key', async () => {
		const resp = await fetch(`${DIRECTORY}/_roster`);
		const { sites } = await resp.json();
		return sites.every((s) => s.gatewayPublicKey) && sites;
	});
	check('every gateway published its identity to its directory', true);

	const states = {};
	await waitFor('every gateway to build two peers', async () => {
		for (const gw of GATEWAYS) states[gw.siteId] = await status(gw);
		return GATEWAYS.every((gw) => {
			const sitePeers = (states[gw.siteId].planned.peers || []).filter((p) => p.kind === 'site');
			return sitePeers.length === 2;
		});
	});

	// THE peer-wipe regression. Two peers each, on the live interface, not just
	// in the plan: `wg setconf` used to leave exactly one.
	for (const gw of GATEWAYS) {
		const live = states[gw.siteId].live;
		const livePeerCount = Object.keys((live && live.peers) || {}).length;
		const expected = gw.siteId === 2 ? 3 : 2; // site 2 also has a device
		check(`site ${gw.siteId} has ${expected} peers on the live interface`,
			livePeerCount === expected, `saw ${livePeerCount}`);
	}

	// Addressing, end to end.
	for (const gw of GATEWAYS) {
		const addresses = states[gw.siteId].planned.addresses;
		check(`site ${gw.siteId} claims 172.24.0.${gw.siteId}/32 and 10.${gw.siteId}.0.1/16`,
			addresses.includes(`172.24.0.${gw.siteId}/32`) && addresses.includes(`10.${gw.siteId}.0.1/16`),
			addresses.join(' '));
	}

	// Only the hub carries the catch-all, and it is never a default route.
	for (const gw of GATEWAYS) {
		if (gw.siteId === 1) continue;
		const hubPeer = states[gw.siteId].planned.peers.find((p) => p.label === 'hub');
		check(`site ${gw.siteId} routes the whole mesh via the hub`,
			!!hubPeer && hubPeer.allowedIPs.includes('10.0.0.0/8'), JSON.stringify(hubPeer && hubPeer.allowedIPs));
		check(`site ${gw.siteId}'s hub peer never claims the default route`,
			!!hubPeer && !hubPeer.allowedIPs.includes('0.0.0.0/0'));
	}

	// A device is a single /32 and nothing more.
	const office = states[2];
	const device = (office.planned.peers || []).find((p) => p.kind === 'client');
	check('the device at site 2 is restricted to exactly its own address',
		!!device && device.allowedIPs.length === 1 && device.allowedIPs[0] === '10.2.128.1/32',
		JSON.stringify(device && device.allowedIPs));

	// Its exit is a separate interface with the default route on it -- the
	// arrangement that makes exit selection expressible at all.
	const exits = office.planned.exits || [];
	check('the device exit built its own interface', exits.length === 1 && exits[0].iface === 'wg-exit-1',
		JSON.stringify(exits.map((e) => e.iface)));
	check('the exit is selected by a rule naming the device',
		(office.planned.exitRules || []).some((r) => r.from === '10.2.128.1/32'),
		JSON.stringify(office.planned.exitRules));
	check('no exit is unbuildable', (office.planned.exitProblems || []).length === 0,
		JSON.stringify(office.planned.exitProblems));

	// NETMAP: both sites are 192.168.1.0/24 and must be distinguishable.
	for (const siteId of [2, 3]) {
		const maps = states[siteId].planned.netmaps || [];
		check(`site ${siteId} maps its LAN into 10.${siteId}.168.0/24`,
			maps.some((m) => m.shadow === `10.${siteId}.168.0/24` && m.physical === '192.168.1.0/24'),
			JSON.stringify(maps));
	}
	check('the two sites\' identical LANs got distinct mesh ranges',
		states[2].planned.netmaps[0].shadow !== states[3].planned.netmaps[0].shadow);

	// The tunnels actually come up. Handshakes are the only honest signal.
	await waitFor('tunnels to handshake', async () => {
		for (const gw of GATEWAYS) states[gw.siteId] = await status(gw);
		return GATEWAYS.every((gw) => {
			const peers = (states[gw.siteId].live.peers) || {};
			const sitePeerKeys = states[gw.siteId].planned.peers
				.filter((p) => p.kind === 'site').map((p) => p.publicKey);
			return sitePeerKeys.every((k) => peers[k] && peers[k].latestHandshake > 0);
		});
	}, 120000);
	check('every site-to-site tunnel completed a handshake', true);

	console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : 'THREE-SITE MESH E2E PASS'}`);
	process.exit(failures ? 1 : 0);
}

main().catch((err) => {
	console.error('\nE2E ERROR:', err.message);
	process.exit(1);
});
