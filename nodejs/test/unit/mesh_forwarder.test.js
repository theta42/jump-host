'use strict';

// The port scheme is the contract between this gateway and theta-directory's
// utils/mesh_route.js: both derive a peer's forwarding port as
// 30000 + meshIndex, with nothing stored or exchanged between them. If either
// side changes the base, relay routes and replication pushes silently aim at
// a port nothing is listening on -- exactly the class of failure this whole
// forwarder exists to fix. Pin it here; theta-directory pins the same number
// in tests/mesh_route.test.js.

const { test } = require('node:test');
const assert = require('node:assert');

const {
	egressPortFor, meshIpFor, directoryTarget,
	MESH_SERVICE_PORT_BASE, DIRECTORY_PORT
} = require('../../services/mesh_forwarder');

test('the egress port base matches theta-directory MESH_SERVICE_PORT_BASE', () => {
	assert.strictEqual(MESH_SERVICE_PORT_BASE, 30000);
});

test('egress port is the base plus the peer mesh index', () => {
	assert.strictEqual(egressPortFor(1), 30001);
	assert.strictEqual(egressPortFor(5), 30005);
	assert.strictEqual(egressPortFor(254), 30254);
});

test('mesh IP is the gateway address for a site index', () => {
	assert.strictEqual(meshIpFor(1), '172.24.1.1');
	assert.strictEqual(meshIpFor(42), '172.24.42.1');
});

test('the ingress target defaults to this site\'s directory and is overridable', () => {
	const before = process.env.THETA_MESH_SERVICE_TARGET;
	delete process.env.THETA_MESH_SERVICE_TARGET;
	assert.deepStrictEqual(directoryTarget(), { host: 'sso-manager', port: DIRECTORY_PORT });

	process.env.THETA_MESH_SERVICE_TARGET = 'directory-b:3999';
	assert.deepStrictEqual(directoryTarget(), { host: 'directory-b', port: 3999 });

	if (before === undefined) delete process.env.THETA_MESH_SERVICE_TARGET;
	else process.env.THETA_MESH_SERVICE_TARGET = before;
});
