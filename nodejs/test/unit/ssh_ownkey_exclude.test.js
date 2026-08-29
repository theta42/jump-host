'use strict';

// Verifies the M21 fix: the jump host excludes its OWN injected key from inbound
// auth by comparing parsed key blobs against its local identity key, not by
// comment text. ssh_server.js can't be required directly in isolation (it pulls
// in bridge.js -> models/metrics -> models/index, a pre-existing circular
// dependency), so this test replicates the exact userKeyMatches blob-comparison
// logic and asserts the cross-site-replication scenario the comment-based
// exclude got wrong.

const { test } = require('node:test');
const assert = require('node:assert');
const { utils: { parseKey } } = require('ssh2');

// Replica of ssh_server.js userKeyMatches (M21 blob-based own-key exclusion).
function userKeyMatches(user, ctxKey, ownKeyBlob) {
	for (const line of user.sshPublicKeys || []) {
		const parsed = parseKey(line);
		if (parsed instanceof Error) continue;
		const key = Array.isArray(parsed) ? parsed[0] : parsed;
		if (ownKeyBlob && key.getPublicSSH().equals(ownKeyBlob)) continue;
		if (key.type === ctxKey.algo && key.getPublicSSH().equals(ctxKey.data)) return key;
	}
	return null;
}

function pubLine(pem, comment) {
	const parsed = parseKey(pem);
	if (parsed instanceof Error) throw parsed;
	const key = Array.isArray(parsed) ? parsed[0] : parsed;
	return `${key.type} ${key.getPublicSSH().toString('base64')} ${comment}`;
}

// An ed25519 keypair as the jump host's own identity, generated the same way
// host_keys.js does (ssh2 ed25519 generator).
function genKeyPair() {
	const { generateKeyPairSync } = require('ssh2').utils;
	const { private: priv } = generateKeyPairSync('ed25519');
	return priv;
}

const ownPrivate = genKeyPair();
const ownBlob = parseKey(ownPrivate).getPublicSSH();

test('a users real key still authenticates', () => {
	const userPrivate = genKeyPair();
	const userLine = pubLine(userPrivate, 'user@laptop');
	const userBlob = parseKey(userPrivate).getPublicSSH();
	const ctxKey = { algo: 'ssh-ed25519', data: userBlob };
	const match = userKeyMatches({ sshPublicKeys: [userLine] }, ctxKey, ownBlob);
	assert.ok(match, 'real user key should match');
});

test('the gateway own key is excluded by blob even with a foreign comment (cross-site replication)', () => {
	// Gateway A's key replicated to gateway B's directory, carrying gateway A's
	// comment. Comment-based exclusion would fail here; blob comparison must win.
	const ownLineForeignComment = pubLine(ownPrivate, 'gatewayA@siteA');
	const ctxKey = { algo: 'ssh-ed25519', data: ownBlob };
	const match = userKeyMatches({ sshPublicKeys: [ownLineForeignComment] }, ctxKey, ownBlob);
	assert.strictEqual(match, null, 'own key must be excluded regardless of comment');
});

test('the gateway own key is excluded by blob even with the local comment', () => {
	const ownLineLocalComment = pubLine(ownPrivate, 'jump-host@local');
	const ctxKey = { algo: 'ssh-ed25519', data: ownBlob };
	const match = userKeyMatches({ sshPublicKeys: [ownLineLocalComment] }, ctxKey, ownBlob);
	assert.strictEqual(match, null, 'own key must be excluded');
});

test('without own-key tracking, a matching key authenticates', () => {
	// ownKeyBlob === null path: falls back to matching any key (pre-M21 behavior
	// when identity key is not yet loaded).
	const ownLineLocalComment = pubLine(ownPrivate, 'jump-host@local');
	const ctxKey = { algo: 'ssh-ed25519', data: ownBlob };
	const match = userKeyMatches({ sshPublicKeys: [ownLineLocalComment] }, ctxKey, null);
	assert.ok(match, 'with no own-key blob set, key should match');
});

test('an unrelated user key does not match a different inbound key', () => {
	const userPrivate = genKeyPair();
	const userLine = pubLine(userPrivate, 'user@laptop');
	const otherPrivate = genKeyPair();
	const otherBlob = parseKey(otherPrivate).getPublicSSH();
	const ctxKey = { algo: 'ssh-ed25519', data: otherBlob };
	const match = userKeyMatches({ sshPublicKeys: [userLine] }, ctxKey, ownBlob);
	assert.strictEqual(match, null, 'unrelated key should not match');
});
