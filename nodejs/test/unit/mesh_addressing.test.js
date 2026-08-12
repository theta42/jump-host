'use strict';

// This MUST agree with theta-directory's utils/mesh_addressing.js, which pins
// the same numbers in its tests/mesh_addressing.test.js. The directory decides
// a site's addresses and this gateway configures them; a disagreement produces
// tunnels that handshake and carry nothing.

const { test } = require('node:test');
const assert = require('node:assert');

const mesh = require('../../utils/mesh_addressing');

test('a site id maps to one mesh address and one /16', () => {
	assert.strictEqual(mesh.meshAddress(4), '172.24.0.4/32');
	assert.strictEqual(mesh.meshIp(4), '172.24.0.4');
	assert.strictEqual(mesh.siteCidr(4), '10.4.0.0/16');
	assert.strictEqual(mesh.siteGatewayIp(4), '10.4.0.1');
	assert.strictEqual(mesh.siteGatewayCidr(4), '10.4.0.1/16');
	assert.strictEqual(mesh.clientPoolCidr(4), '10.4.128.0/17');
});

test('site ids are limited to a single octet', () => {
	assert.strictEqual(mesh.MAX_SITE_ID, 254);
	assert.throws(() => mesh.meshAddress(255), /site id must be an integer/);
	assert.throws(() => mesh.meshAddress(0), /site id must be an integer/);
});

test('a peer gateway is allowed exactly its own /32 and its site /16', () => {
	assert.deepStrictEqual(mesh.peerAllowedIps(6), ['172.24.0.6/32', '10.6.0.0/16']);
});

// AllowedIPs is one trie per interface: a peer claiming the default route
// takes it from every other peer, which is what makes multi-exit selection
// impossible on a shared interface. Exits get their own interfaces.
test('the hub catch-all never includes a default route', () => {
	const hub = mesh.hubAllowedIps();
	assert.deepStrictEqual(hub, ['10.0.0.0/8', '172.24.0.0/16']);
	assert.ok(!hub.includes('0.0.0.0/0'));
});

test('shadow slots map a physical LAN into the site /16', () => {
	assert.strictEqual(mesh.shadowCidr(3, 168), '10.3.168.0/24');
	assert.strictEqual(mesh.shadowCidr(3, 172), '10.3.172.0/24');
	assert.throws(() => mesh.shadowCidr(3, 99), /shadow slot must be/);
	assert.deepStrictEqual(mesh.SHADOW_SLOTS, [168, 172]);
});
