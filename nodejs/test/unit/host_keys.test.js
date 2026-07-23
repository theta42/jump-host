'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureKeys, pubLine, generatePair } = require('../../utils/host_keys');

process.env.NODE_ENV = 'test';

test('generates a parseable ed25519 public line', () => {
	const pem = generatePair('ed25519');
	const line = pubLine(pem, 'jump-host@test');
	assert.match(line, /^ssh-ed25519 [A-Za-z0-9+/=]+ jump-host@test$/);
});

test('ensureKeys writes and reloads a stable keypair', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-keys-'));
	const conf = require('@simpleworkjs/conf');
	conf.ssh = { ...conf.ssh, hostKeyPath: dir, keyComment: 'jump-host@test' };

	const first = ensureKeys(dir);
	assert.strictEqual(first.hostKeys.length, 2);
	assert.match(first.publicLine, /jump-host@test$/);

	const second = ensureKeys(dir);
	assert.strictEqual(second.publicLine, first.publicLine); // stable, not regenerated
	assert.ok(fs.existsSync(path.join(dir, 'id_ed25519')));
	assert.ok(fs.existsSync(path.join(dir, 'id_rsa')));
});
