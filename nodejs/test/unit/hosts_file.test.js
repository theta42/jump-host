'use strict';

// Unit tests for the ORM-backed host inventory (utils/hosts_file.js).
// Uses a temp file SQLite database — no external services needed.

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const conf = require('@simpleworkjs/conf');
const { init } = require('@simpleworkjs/orm');
const StandaloneHost = require('../../models/standalone_host');

let tmpDir;
let hostsFile; // required after ORM init

before(async () => {
  // Unique temp DB so this test file doesn't collide with other ORM tests.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jump-host-test-hostfile-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');

  conf.standalone = { enabled: true };
  conf.orm = { dialect: 'sqlite', storage: dbPath, logging: false };

  await init({ conf: { orm: conf.orm }, models: [StandaloneHost] });

  await StandaloneHost.create({
    slug: 'host_web01',
    displayName: 'Web Server 01',
    kind: 'host',
    metadata: { address: 'ssh://10.0.0.10:22', ip: '10.0.0.10', sshPort: 22 },
  });
  await StandaloneHost.create({
    slug: 'host_db',
    displayName: 'Database Server',
    kind: 'host',
    metadata: { address: 'ssh://10.0.0.20:22', ip: '10.0.0.20', sshPort: 22 },
  });
  await StandaloneHost.create({
    slug: 'app_gitea',
    displayName: 'Gitea',
    kind: 'service',
    metadata: { url: 'https://gitea.internal' },
  });

  hostsFile = require('../../utils/hosts_file');
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('accessibleHosts returns all hosts', async () => {
  const hosts = await hostsFile.accessibleHosts({ uid: 'alice' });
  assert.strictEqual(hosts.length, 2);
  const slugs = hosts.map((h) => h.slug).sort();
  assert.deepStrictEqual(slugs, ['host_db', 'host_web01']);
});

test('accessibleHosts filters to kind=host', async () => {
  const hosts = await hostsFile.accessibleHosts({ uid: 'alice' });
  const kinds = [...new Set(hosts.map((h) => h.kind))];
  assert.deepStrictEqual(kinds, ['host']);
});

test('accessibleHosts returns host resources with expected shape', async () => {
  const hosts = await hostsFile.accessibleHosts({ uid: 'alice' });
  const web = hosts.find((h) => h.slug === 'host_web01');
  assert.ok(web);
  assert.strictEqual(web.id, 'host_web01');
  assert.strictEqual(web.displayName, 'Web Server 01');
  assert.strictEqual(web.metadata.ip, '10.0.0.10');
  assert.strictEqual(web.metadata.sshPort, 22);
});

test('accessibleHosts returns empty array when no hosts exist', async () => {
  // Delete all hosts and verify empty result.
  const all = await StandaloneHost.list();
  for (const h of all) {
    await h.delete({ force: true });
  }
  const hosts = await hostsFile.accessibleHosts({ uid: 'alice' });
  assert.deepStrictEqual(hosts, []);
});
