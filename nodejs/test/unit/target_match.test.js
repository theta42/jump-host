'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { matchTarget, hostEndpoint } = require('../../utils/target_match');

const hosts = [
	{ id: '1', slug: 'host_web01', name: 'Web 01', metadata: { ip: '10.0.0.10', sshPort: 2200 } },
	{ id: '2', slug: 'host_db', name: 'Database', metadata: { address: 'ssh://db.internal:22' } },
];

test('exact slug', () => {
	assert.strictEqual(matchTarget('host_web01', hosts).host.id, '1');
});

test('host_-prefixed shorthand', () => {
	assert.strictEqual(matchTarget('web01', hosts).host.id, '1');
});

test('by display name (case-insensitive)', () => {
	assert.strictEqual(matchTarget('database', hosts).host.id, '2');
});

test('by ip', () => {
	assert.strictEqual(matchTarget('10.0.0.10', hosts).host.id, '1');
});

test('by address hostname', () => {
	assert.strictEqual(matchTarget('db.internal', hosts).host.id, '2');
});

test('raw IP denied by default', () => {
	assert.throws(() => matchTarget('8.8.8.8', hosts), (e) => e.code === 'no-such-target');
});

test('raw IP allowed when configured', () => {
	const m = matchTarget('8.8.8.8', hosts, { allowRawIPs: true });
	assert.strictEqual(m.host, null);
	assert.strictEqual(m.raw, '8.8.8.8');
});

test('unknown slug denied', () => {
	assert.throws(() => matchTarget('nope', hosts), (e) => e.code === 'no-such-target');
});

test('hostEndpoint uses sshPort then default', () => {
	assert.deepStrictEqual(hostEndpoint(hosts[0], 22), { address: '10.0.0.10', port: 2200 });
	assert.deepStrictEqual(hostEndpoint(hosts[1], 22), { address: 'db.internal', port: 22 });
});
