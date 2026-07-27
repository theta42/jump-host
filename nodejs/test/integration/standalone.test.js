'use strict';

// End-to-end standalone SSH test: a real downstream sshd, the full jump host
// SSH server (ssh_server.js), and an SSH client. Authentication and host
// discovery use the ORM-backed standalone stores (temp file SQLite).
//
// Follows the same hermetic pattern as ssh_bridge.test.js but exercises the
// full stack: conf → ORM → user_ldap facade → ssh_server → bridge.

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Server, Client, utils } = require('ssh2');
const bcrypt = require('bcrypt');
const conf = require('@simpleworkjs/conf');

// ── Conf must be set BEFORE any module that checks conf.standalone.enabled ──

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jump-host-standalone-'));
const dbPath = path.join(tmpDir, 'test.sqlite');

conf.standalone = { enabled: true };
conf.orm = { dialect: 'sqlite', storage: dbPath, logging: false };
conf.ssh = {
  listenHost: '127.0.0.1',
  listenPort: 0,
  hostKeyPath: path.join(tmpDir, 'keys'),
  passwordAuth: 'all',
  keyComment: 'jump-host-test',
  defaultPort: 22,
  connectTimeoutMs: 5000,
  maxSessions: 10,
};
conf.redis = { prefix: 'jump_host_test_standalone_' };
conf.audit = { maxEvents: 100 };

// ── Require models/index FIRST so it initializes the ORM exactly once.
//    This also registers the standalone models. We await ormReady before
//    seeding data, then start the SSH server. ──

const models = require('../../models');
const StandaloneUser = require('../../models/standalone_user');
const StandaloneHost = require('../../models/standalone_host');

let downstream, downstreamPort, jump, jumpPort;
let testUserKey;

function startDownstream() {
  return new Promise((resolve) => {
    const { private: hostKey } = utils.generateKeyPairSync('ed25519');
    const srv = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on('authentication', (ctx) => ctx.accept());
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('pty', (a) => a && a());
          session.on('shell', (a) => {
            const ch = a();
            ch.write('downstream-shell-ready\n');
            ch.on('data', (d) => ch.write('echo:' + d));
          });
          session.on('exec', (a, r, info) => {
            const ch = a();
            ch.write(`ran:${info.command}`);
            ch.exit(0);
            ch.end();
          });
          session.on('subsystem', (a, r, info) => {
            if (info.name !== 'sftp') return r && r();
            const ch = a();
            ch.on('data', (d) => ch.write(Buffer.concat([Buffer.from('sftp:'), d])));
          });
        });
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

before(async () => {
  // 1. Start downstream.
  downstream = await startDownstream();
  downstreamPort = downstream.address().port;

  // 2. Wait for the ORM to finish syncing tables (init was called by models/index
  //    at require time — we just need the tables to exist before seeding).
  await models.ormReady;

  // 3. Seed test data.
  const userKeyPair = utils.generateKeyPairSync('ed25519');
  testUserKey = userKeyPair.private;
  const userPubKey = utils.parseKey(userKeyPair.private);
  const userPubLine = `${userPubKey.type} ${userPubKey.getPublicSSH().toString('base64')} testuser@test`;

  const passwordHash = await bcrypt.hash('testpass', 4);

  await StandaloneUser.create({
    uid: 'testuser',
    passwordHash,
    sshPublicKeys: [userPubLine],
    groups: ['admin'],
  });

  await StandaloneHost.create({
    slug: 'host_test',
    displayName: 'Test Downstream',
    kind: 'host',
    metadata: { address: `ssh://127.0.0.1:${downstreamPort}`, ip: '127.0.0.1', sshPort: downstreamPort },
  });

  // 4. Start the jump host SSH server.
  const sshServer = require('../../services/ssh_server');
  jump = sshServer.start();
  await new Promise((resolve) => {
    const check = () => {
      const addr = jump.address();
      if (addr) { jumpPort = addr.port; resolve(); }
      else setTimeout(check, 10);
    };
    check();
  });
});

after(() => {
  try { downstream && downstream.close(); } catch (_) {}
  try { jump && jump.close(); } catch (_) {}
  try { models.redisClient.destroy(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

process.on('unhandledRejection', () => {});

function connectJump(opts = {}) {
  const conn = new Client();
  const connectOpts = {
    host: '127.0.0.1',
    port: jumpPort,
    username: opts.username || 'testuser_-_host_test',
    ...opts,
  };
  return {
    conn,
    ready: new Promise((res, rej) => {
      conn.on('ready', res).on('error', rej).connect(connectOpts);
    }),
  };
}

// ── Tests ──

test('public key auth + grammar mode exec', async () => {
  const { conn, ready } = connectJump({ privateKey: testUserKey });
  await ready;
  const out = await new Promise((resolve, reject) => {
    conn.exec('hello-world', (err, stream) => {
      if (err) return reject(err);
      let buf = '';
      stream.on('data', (d) => { buf += d; }).on('close', () => resolve(buf));
    });
  });
  conn.end();
  assert.match(out, /ran:hello-world/);
});

test('public key auth + grammar mode shell', async () => {
  const { conn, ready } = connectJump({ privateKey: testUserKey });
  await ready;
  const out = await new Promise((resolve, reject) => {
    conn.shell((err, stream) => {
      if (err) return reject(err);
      let buf = '';
      stream.on('data', (d) => {
        buf += d;
        if (buf.includes('echo:ping')) resolve(buf);
      });
      setTimeout(() => stream.write('ping'), 150);
      setTimeout(() => resolve(buf), 5000);
    });
  });
  conn.end();
  assert.match(out, /downstream-shell-ready/);
  assert.match(out, /echo:ping/);
});

test('password auth + grammar mode exec', async () => {
  const { conn, ready } = connectJump({
    username: 'testuser_-_host_test',
    password: 'testpass',
  });
  await ready;
  const out = await new Promise((resolve, reject) => {
    conn.exec('pw-test', (err, stream) => {
      if (err) return reject(err);
      let buf = '';
      stream.on('data', (d) => { buf += d; }).on('close', () => resolve(buf));
    });
  });
  conn.end();
  assert.match(out, /ran:pw-test/);
});

test('password auth denied with wrong password', async () => {
  const conn = new Client();
  const result = await new Promise((resolve) => {
    conn.on('ready', () => resolve('unexpected-ready'));
    conn.on('error', () => resolve('auth-failed'));
    conn.connect({
      host: '127.0.0.1', port: jumpPort,
      username: 'testuser_-_host_test',
      password: 'wrongpass',
    });
  });
  assert.strictEqual(result, 'auth-failed');
});

test('unknown user rejected', async () => {
  const conn = new Client();
  const result = await new Promise((resolve) => {
    conn.on('ready', () => resolve('unexpected-ready'));
    conn.on('error', () => resolve('auth-failed'));
    conn.connect({
      host: '127.0.0.1', port: jumpPort,
      username: 'nobody_-_host_test',
      password: 'testpass',
    });
  });
  assert.strictEqual(result, 'auth-failed');
});
