'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseUsername, isIPv4 } = require('../../utils/username_grammar');

test('plain uid → picker mode', () => {
	assert.deepStrictEqual(parseUsername('alice'), { uid: 'alice', target: null });
});

test('uid_-_slug → grammar mode', () => {
	assert.deepStrictEqual(parseUsername('alice_-_web01'), { uid: 'alice', target: 'web01' });
});

test('uid_-_host_slug (prefixed target)', () => {
	assert.deepStrictEqual(parseUsername('bob_-_host_pve1'), { uid: 'bob', target: 'host_pve1' });
});

test('uid_-_ipv4', () => {
	assert.deepStrictEqual(parseUsername('bob_-_10.0.0.5'), { uid: 'bob', target: '10.0.0.5' });
});

test('splits on first _-_ only', () => {
	// target may legitimately contain a dash; the separator is the first _-_
	assert.deepStrictEqual(parseUsername('carol_-_web-01'), { uid: 'carol', target: 'web-01' });
});

test('rejects invalid uid', () => {
	assert.throws(() => parseUsername('Bad Uid'));
	assert.throws(() => parseUsername('1abc'));
});

test('rejects empty target', () => {
	assert.throws(() => parseUsername('alice_-_'));
});

test('rejects empty username', () => {
	assert.throws(() => parseUsername(''));
});

test('isIPv4', () => {
	assert.ok(isIPv4('192.168.1.1'));
	assert.ok(!isIPv4('999.1.1.1'));
	assert.ok(!isIPv4('web01'));
});
