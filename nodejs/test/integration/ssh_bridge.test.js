'use strict';

// End-to-end bridge test with NO external services: a tiny in-process ssh2
// "downstream" server (echo shell + exec + sftp-subsystem byte echo) and the
// jump host's own bridge, driven by an ssh2 client as `test_-_stub`.
//
// The jump host's LDAP/directory/redis dependencies are stubbed via injected
// modules so the test needs only ssh2 + generated keys.

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Server, Client, utils } = require('ssh2');

const { connectUpstream, attachSession } = require('../../services/bridge');

let downstream, downstreamPort, jump, jumpPort, jumpKey;

// --- A minimal downstream sshd: accepts any key, echoes shell/exec, and
//     echoes bytes on the sftp subsystem (enough to prove pass-through). ---
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
						ch.on('data', (d) => ch.write('echo:' + d)); // echo back
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

// --- The jump host, wired to bridge every session straight to the downstream
//     (target resolution stubbed to the downstream endpoint). ---
function startJump() {
	return new Promise((resolve) => {
		const { private: hostKey } = utils.generateKeyPairSync('ed25519');
		const gen = utils.generateKeyPairSync('ed25519');
		jumpKey = gen.private;
		const clientAuthKey = utils.parseKey(gen.private); // user authenticates with the SAME key for the test

		const srv = new Server({ hostKeys: [hostKey] }, (client) => {
			client.on('authentication', (ctx) => {
				if (ctx.method === 'publickey') {
					const k = clientAuthKey;
					if (ctx.key.algo === k.type && k.getPublicSSH().equals(ctx.key.data)) {
						if (ctx.signature) {
							return k.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject();
						}
						return ctx.accept();
					}
				}
				return ctx.reject(['publickey']);
			});
			client.on('ready', () => {
				client.once('session', (accept) => {
					const session = accept();
					const audit = { patch() {}, finish() {}, event: {} };
					// Attach synchronously with a deferred upstream — exactly how
					// runGrammar wires it — so pre-connect channel requests buffer.
					const upstreamPromise = connectUpstream({
						host: '127.0.0.1', port: downstreamPort,
						username: 'test', privateKey: jumpKey, uid: 'test', justInjected: false,
					});
					attachSession(session, upstreamPromise, audit);
					upstreamPromise.catch(() => client.end());
				});
			});
		});
		srv.listen(0, '127.0.0.1', () => resolve({ srv, key: gen.private }));
	});
}

before(async () => {
	downstream = await startDownstream();
	downstreamPort = downstream.address().port;
	const j = await startJump();
	jump = j.srv;
	jumpPort = jump.address().port;
});

after(() => {
	downstream && downstream.close();
	jump && jump.close();
	// bridge.js pulls in model-redis (via key_inject/metrics), which eagerly
	// opens a redis client. This test never touches redis (audit is stubbed),
	// so drop the connection so the process can exit.
	try { require('../../models').redisClient.destroy(); } catch (_) {}
});

// The eager model-redis connect has no server in this hermetic test; ignore it.
process.on('unhandledRejection', () => {});

function connectJump() {
	const conn = new Client();
	return { conn, ready: new Promise((res, rej) => {
		conn.on('ready', res).on('error', rej).connect({
			host: '127.0.0.1', port: jumpPort, username: 'test_-_stub',
			privateKey: jumpKey, // same key stubbed as the user's inbound key
		});
	}) };
}

test('exec bridges through to the downstream', async () => {
	const { conn, ready } = connectJump();
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

test('shell bridges and echoes', async () => {
	const { conn, ready } = connectJump();
	await ready;
	const out = await new Promise((resolve, reject) => {
		conn.shell((err, stream) => {
			if (err) return reject(err);
			let buf = '';
			stream.on('data', (d) => {
				buf += d;
				if (buf.includes('echo:ping')) { resolve(buf); }
			});
			setTimeout(() => stream.write('ping'), 100);
			setTimeout(() => resolve(buf), 1500);
		});
	});
	conn.end();
	assert.match(out, /downstream-shell-ready/);
	assert.match(out, /echo:ping/);
});

test('sftp subsystem bytes pass through', async () => {
	const { conn, ready } = connectJump();
	await ready;
	const got = await new Promise((resolve, reject) => {
		conn.subsys('sftp', (err, stream) => {
			if (err) return reject(err);
			let buf = Buffer.alloc(0);
			stream.on('data', (d) => {
				buf = Buffer.concat([buf, d]);
				if (buf.includes('sftp:')) resolve(buf.toString());
			});
			stream.write(Buffer.from('PKT'));
			setTimeout(() => resolve(buf.toString()), 1500);
		});
	});
	conn.end();
	assert.match(got, /sftp:PKT/);
});
