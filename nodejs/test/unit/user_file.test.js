'use strict';

// Unit tests for the ORM-backed user store (models/user_file.js).
// Uses a temp file SQLite database — no external services needed.

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcrypt');
const conf = require('@simpleworkjs/conf');
const { init } = require('@simpleworkjs/orm');
const StandaloneUser = require('../../models/standalone_user');

let testPasswordHash;
let tmpDir;
let userFile; // required after ORM init

before(async () => {
  // Unique temp DB so this test file doesn't collide with other ORM tests.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jump-host-test-userfile-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');

  conf.standalone = { enabled: true };
  conf.orm = { dialect: 'sqlite', storage: dbPath, logging: false };

  await init({ conf: { orm: conf.orm }, models: [StandaloneUser] });

  testPasswordHash = await bcrypt.hash('testpass', 4);

  await StandaloneUser.create({
    uid: 'alice',
    passwordHash: testPasswordHash,
    sshPublicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... alice@laptop'],
    groups: ['admin', 'developers'],
  });

  // Now that the ORM is initialized and conf.standalone is set, require the
  // facade. It checks conf.standalone.enabled at require time.
  userFile = require('../../models/user_file');
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('getUser returns user with synthesized dn and keys', async () => {
  const user = await userFile.getUser('alice');
  assert.ok(user);
  assert.strictEqual(user.uid, 'alice');
  assert.strictEqual(user.dn, 'uid=alice,ou=people,dc=standalone,dc=local');
  assert.deepStrictEqual(user.sshPublicKeys, ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... alice@laptop']);
});

test('getUser returns null for unknown uid', async () => {
  const user = await userFile.getUser('nobody');
  assert.strictEqual(user, null);
});

test('getGroups returns user groups', async () => {
  const groups = await userFile.getGroups('uid=alice,ou=people,dc=standalone,dc=local');
  assert.deepStrictEqual(groups, ['admin', 'developers']);
});

test('getGroups returns empty array for unknown dn', async () => {
  const groups = await userFile.getGroups('uid=nobody,ou=people,dc=standalone,dc=local');
  assert.deepStrictEqual(groups, []);
});

test('getGroups returns empty array for malformed dn', async () => {
  const groups = await userFile.getGroups('not-a-dn');
  assert.deepStrictEqual(groups, []);
});

test('checkPassword returns true for correct password', async () => {
  const ok = await userFile.checkPassword('uid=alice,ou=people,dc=standalone,dc=local', 'testpass');
  assert.strictEqual(ok, true);
});

test('checkPassword returns false for wrong password', async () => {
  const ok = await userFile.checkPassword('uid=alice,ou=people,dc=standalone,dc=local', 'wrongpass');
  assert.strictEqual(ok, false);
});

test('checkPassword returns false for unknown user', async () => {
  const ok = await userFile.checkPassword('uid=nobody,ou=people,dc=standalone,dc=local', 'testpass');
  assert.strictEqual(ok, false);
});

test('addSshKey appends a new key', async () => {
  const newKey = 'ssh-rsa AAAAB3NzaC1yc2E... bob@desktop';
  await userFile.addSshKey('uid=alice,ou=people,dc=standalone,dc=local', newKey);

  const user = await StandaloneUser.get('alice');
  assert.ok(user.sshPublicKeys.includes(newKey));
});

test('addSshKey is idempotent', async () => {
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... alice@laptop';
  const userBefore = await StandaloneUser.get('alice');
  const countBefore = userBefore.sshPublicKeys.length;
  await userFile.addSshKey('uid=alice,ou=people,dc=standalone,dc=local', key);
  const userAfter = await StandaloneUser.get('alice');
  assert.strictEqual(userAfter.sshPublicKeys.length, countBefore);
});

test('addSshKey is a no-op for unknown user', async () => {
  // Should not throw.
  await userFile.addSshKey('uid=nobody,ou=people,dc=standalone,dc=local', 'ssh-rsa AAA...');
});
