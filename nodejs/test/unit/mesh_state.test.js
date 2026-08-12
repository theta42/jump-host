'use strict';

// Turning the directory's roster into an interface plan. These are the rules
// that decide what actually gets configured, so they are tested apart from the
// `wg`/`ip`/`iptables` calls that carry them out.

const { test } = require('node:test');
const assert = require('node:assert');

const { planReconcile } = require('../../services/mesh_state');

const SITE_KEY = (n) => Buffer.from(`site-${n}-public-key-padding-000`).toString('base64').slice(0, 44);
const CLIENT_KEY = (n) => Buffer.from(`client-${n}-public-key-padding-0`).toString('base64').slice(0, 44);

const peersDoc = (over = {}) => ({
	localSiteId: 2,
	hubSiteId: 1,
	peers: [
		{ siteId: 1, slug: 'hub', publicKey: SITE_KEY(1), endpoint: 'hub.example:51820', isHub: true,
			allowedIps: ['10.0.0.0/8', '172.24.0.0/16', '172.24.0.1/32', '10.1.0.0/16'] },
		{ siteId: 5, slug: 'nl', publicKey: SITE_KEY(5), endpoint: 'nl.example:51820', isHub: false,
			allowedIps: ['172.24.0.5/32', '10.5.0.0/16'] }
	],
	...over
});

const clientsDoc = (clients) => ({ localSiteId: 2, clients: clients || [] });

test('a site without an id configures nothing', () => {
	// A gateway whose site has not joined a directory has no addresses to
	// claim -- it must not invent any.
	const plan = planReconcile({ localSiteId: null, peers: [] }, clientsDoc(), null);
	assert.strictEqual(plan.ready, false);
	assert.deepStrictEqual(plan.addresses, []);
	assert.deepStrictEqual(plan.peers, []);
});

test('the gateway takes both its mesh identity and its site router address', () => {
	const plan = planReconcile(peersDoc(), clientsDoc(), null);
	// 172.24.0.2/32 is how other gateways know us; 10.2.0.1/16 is how this
	// site's own clients and services get onto the mesh.
	assert.deepStrictEqual(plan.addresses, ['172.24.0.2/32', '10.2.0.1/16']);
	assert.strictEqual(plan.siteCidr, '10.2.0.0/16');
});

test('peer AllowedIPs come from the directory unchanged', () => {
	// The directory resolves them, so the addressing rules live in one place
	// rather than being reimplemented on every gateway.
	const plan = planReconcile(peersDoc(), clientsDoc(), null);
	const hub = plan.peers.find((p) => p.label === 'hub');
	assert.deepStrictEqual(hub.allowedIPs, ['10.0.0.0/8', '172.24.0.0/16', '172.24.0.1/32', '10.1.0.0/16']);
});

test('only peers we can dial get a keepalive', () => {
	const doc = peersDoc();
	doc.peers.push({ siteId: 7, slug: 'behind-nat', publicKey: SITE_KEY(7), endpoint: '', allowedIps: ['172.24.0.7/32', '10.7.0.0/16'] });
	const plan = planReconcile(doc, clientsDoc(), null);

	assert.strictEqual(plan.peers.find((p) => p.label === 'hub').keepalive, 25);
	// A peer with no endpoint is one that dials US; a keepalive would have
	// nowhere to send.
	assert.strictEqual(plan.peers.find((p) => p.label === 'behind-nat').keepalive, 0);
});

test('a peer with no public key is skipped rather than half-applied', () => {
	const doc = peersDoc();
	doc.peers.push({ siteId: 9, slug: 'unpublished', publicKey: '', allowedIps: ['10.9.0.0/16'] });
	const plan = planReconcile(doc, clientsDoc(), null);
	assert.ok(!plan.peers.some((p) => p.label === 'unpublished'));
});

// A site that has joined the directory but whose gateway has never started has
// a roster row and no key -- it must not break everyone else's reconcile.
test('a peer with no routes is skipped', () => {
	const doc = peersDoc();
	doc.peers.push({ siteId: 9, slug: 'no-routes', publicKey: SITE_KEY(9), allowedIps: [] });
	const plan = planReconcile(doc, clientsDoc(), null);
	assert.ok(!plan.peers.some((p) => p.label === 'no-routes'));
});

test('local devices become peers restricted to exactly one address', () => {
	const plan = planReconcile(peersDoc(), clientsDoc([
		{ uid: 'alice', name: 'laptop', publicKey: CLIENT_KEY(1), assignedIp: '10.2.128.1', exitSiteId: null },
		{ uid: 'bob', name: 'phone', publicKey: CLIENT_KEY(2), assignedIp: '10.2.128.2', exitSiteId: 5 }
	]), null);

	const laptop = plan.peers.find((p) => p.label === 'alice/laptop');
	// A /32 and nothing else: one compromised laptop must not be able to
	// source traffic for another site's whole /16.
	assert.deepStrictEqual(laptop.allowedIPs, ['10.2.128.1/32']);
	assert.strictEqual(laptop.kind, 'client');
	assert.strictEqual(laptop.endpoint, '');
	assert.strictEqual(plan.peers.find((p) => p.label === 'bob/phone').exitSiteId, 5);
});

test('sites and devices share one interface without colliding', () => {
	const plan = planReconcile(peersDoc(), clientsDoc([
		{ uid: 'alice', name: 'laptop', publicKey: CLIENT_KEY(1), assignedIp: '10.2.128.1', exitSiteId: null }
	]), null);

	// A local client's /32 lives inside THIS site's /16, which is never
	// allowed to any site peer -- so nothing overlaps and one interface is
	// enough. (The hub's 10.0.0.0/8 does cover it, but longest-prefix match
	// gives the /32 to the client.)
	const allSitePrefixes = plan.peers.filter((p) => p.kind === 'site').flatMap((p) => p.allowedIPs);
	assert.ok(!allSitePrefixes.includes('10.2.0.0/16'));
	assert.strictEqual(plan.peers.length, 3);
});

test('the mesh routes get traffic into WireGuard at all', () => {
	// `wg set allowed-ips` only configures crypto routing; without a kernel
	// route nothing is ever handed to the interface. Learned the hard way.
	const plan = planReconcile(peersDoc(), clientsDoc(), null);
	assert.deepStrictEqual(plan.routes.map((r) => r.cidr), ['10.0.0.0/8', '172.24.0.0/16']);
});

test('LAN mappings are built only for shadows the site has configured', () => {
	const plan = planReconcile(peersDoc(), clientsDoc(), { siteId: 2, lan168: '192.168.1.0/24' });
	assert.deepStrictEqual(plan.netmaps, [{ slot: 168, shadow: '10.2.168.0/24', physical: '192.168.1.0/24' }]);
});

test('both shadow slots map when both LANs are configured', () => {
	const plan = planReconcile(peersDoc(), clientsDoc(), { siteId: 2, lan168: '192.168.50.0/24', lan172: '172.16.0.0/24' });
	assert.deepStrictEqual(plan.netmaps, [
		{ slot: 168, shadow: '10.2.168.0/24', physical: '192.168.50.0/24' },
		{ slot: 172, shadow: '10.2.172.0/24', physical: '172.16.0.0/24' }
	]);
});

test('a site with no LAN configured maps nothing', () => {
	assert.deepStrictEqual(planReconcile(peersDoc(), clientsDoc(), null).netmaps, []);
	assert.deepStrictEqual(planReconcile(peersDoc(), clientsDoc(), { siteId: 2 }).netmaps, []);
});

test('a site id with no address space is refused loudly', () => {
	assert.throws(() => planReconcile({ localSiteId: 300, peers: [] }, clientsDoc(), null), /site id must be an integer/);
});

test('missing client data is treated as no devices, not as an error', () => {
	// The devices fetch can fail independently of the peers fetch; losing it
	// must not tear down site-to-site tunnels.
	const plan = planReconcile(peersDoc(), null, null);
	assert.strictEqual(plan.ready, true);
	assert.strictEqual(plan.peers.filter((p) => p.kind === 'client').length, 0);
	assert.strictEqual(plan.peers.filter((p) => p.kind === 'site').length, 2);
});
