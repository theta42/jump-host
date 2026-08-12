'use strict';

// The rules that decide what the wg-mesh interface should look like, given
// what's in the peer registry. These are the rules that were wrong or missing
// before: the registry survives a restart and the interface does not, so
// something has to be able to rebuild one from the other -- and it has to
// identify THIS gateway by something a remote peer cannot forge.

const { test } = require('node:test');
const assert = require('node:assert');

const { planReconcile, selfEntry } = require('../../services/mesh_state');

const OUR_KEY = 'b3VyLWdhdGV3YXktcHVibGljLWtleS0wMDAwMDAwMDA=';
const PEER_KEY = 'cGVlci1nYXRld2F5LXB1YmxpYy1rZXktMDAwMDAwMDA=';
const OTHER_KEY = 'b3RoZXItZ2F0ZXdheS1wdWJsaWMta2V5LTAwMDAwMDA=';

const entry = (over) => ({
	id: 'id-' + Math.random().toString(16).slice(2),
	publicKey: PEER_KEY, endpoint: 'peer:51820', siteSlug: 'site-b', meshIndex: 2,
	...over
});

test('the self-entry is found by public key', () => {
	const gateways = [entry({ publicKey: PEER_KEY }), entry({ publicKey: OUR_KEY, siteSlug: '(self)', meshIndex: 1 })];
	assert.strictEqual(selfEntry(gateways, OUR_KEY).meshIndex, 1);
});

// The '(self)' slug arrives in the REMOTE's POST /api/mesh/register body, so
// it is attacker-controlled. Trusting it let a peer impersonate this
// gateway's own entry -- which decides where mesh_forwarder binds its ingress
// listener and which entry DELETE /api/mesh/gateways/:id refuses to remove.
test('a peer that registers itself as "(self)" is not mistaken for us', () => {
	const gateways = [
		entry({ publicKey: PEER_KEY, siteSlug: '(self)', meshIndex: 7 }),
		entry({ publicKey: OUR_KEY, siteSlug: 'site-a', meshIndex: 1 })
	];

	const self = selfEntry(gateways, OUR_KEY);
	assert.strictEqual(self.publicKey, OUR_KEY);
	assert.strictEqual(self.meshIndex, 1);

	// ...and the impostor is treated as an ordinary peer, so it still gets an
	// egress listener and stays deletable.
	const plan = planReconcile(gateways, OUR_KEY);
	assert.strictEqual(plan.meshIndex, 1);
	assert.deepStrictEqual(plan.peers.map((p) => p.publicKey), [PEER_KEY]);
});

test('a gateway that has never meshed brings up no interface at all', () => {
	const plan = planReconcile([], OUR_KEY);
	assert.strictEqual(plan.joined, false);
	assert.strictEqual(plan.address, null);
	assert.deepStrictEqual(plan.peers, []);
});

test('an entry with no mesh index cannot be this gateway either', () => {
	const plan = planReconcile([entry({ publicKey: OUR_KEY, meshIndex: 0 })], OUR_KEY);
	assert.strictEqual(plan.joined, false);
});

test('the plan restores this gateway address and every peer', () => {
	const gateways = [
		entry({ publicKey: OUR_KEY, siteSlug: '(self)', meshIndex: 1 }),
		entry({ publicKey: PEER_KEY, endpoint: 'b.example:51820', meshIndex: 2 }),
		entry({ publicKey: OTHER_KEY, endpoint: 'c.example:51820', meshIndex: 3 })
	];

	const plan = planReconcile(gateways, OUR_KEY);
	assert.strictEqual(plan.joined, true);
	assert.strictEqual(plan.address, '172.24.1.1/24');
	assert.strictEqual(plan.peers.length, 2);

	// Each peer gets BOTH the mesh /24 and that site's reserved 10.<idx>.0.0/16
	// -- the same AllowedIPs the live join path applies, since a rebuilt
	// interface that routes less than the original is just a subtler outage.
	assert.deepStrictEqual(plan.peers[0].allowedIPs, ['172.24.2.0/24', '10.2.0.0/16']);
	assert.deepStrictEqual(plan.peers[1].allowedIPs, ['172.24.3.0/24', '10.3.0.0/16']);
	assert.strictEqual(plan.peers[0].endpoint, 'b.example:51820');
});

test('this gateway is never included as a peer of itself', () => {
	const gateways = [entry({ publicKey: OUR_KEY, siteSlug: '(self)', meshIndex: 1 })];
	assert.deepStrictEqual(planReconcile(gateways, OUR_KEY).peers, []);
});

// A half-written registry row must not take the whole mesh down with it.
test('unusable registry rows are skipped, not fatal', () => {
	const gateways = [
		entry({ publicKey: OUR_KEY, siteSlug: '(self)', meshIndex: 1 }),
		entry({ publicKey: '', meshIndex: 4 }),
		entry({ publicKey: OTHER_KEY, meshIndex: 0 }),
		entry({ publicKey: PEER_KEY, meshIndex: 5 })
	];

	const plan = planReconcile(gateways, OUR_KEY);
	assert.deepStrictEqual(plan.peers.map((p) => p.meshIndex), [5]);
});

// mesh_gateway stores every field as a Redis hash string; a peer index that
// arrives as "3" must still produce numeric addressing.
test('string mesh indexes from Redis are normalised', () => {
	const gateways = [
		entry({ publicKey: OUR_KEY, siteSlug: '(self)', meshIndex: '1' }),
		entry({ publicKey: PEER_KEY, meshIndex: '3' })
	];

	const plan = planReconcile(gateways, OUR_KEY);
	assert.strictEqual(plan.address, '172.24.1.1/24');
	assert.deepStrictEqual(plan.peers[0].allowedIPs, ['172.24.3.0/24', '10.3.0.0/16']);
});
