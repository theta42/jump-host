'use strict';

// Bridge one authenticated inbound SSH session to a downstream host: open an
// ssh2.Client to the target as the real user (jump host's own private key —
// already injected into the user's sshPublicKey), then splice each inbound
// channel (shell / exec / sftp subsystem) to a matching upstream channel.

const { Client } = require('ssh2');
const crypto = require('crypto');
const { Transform } = require('stream');
const conf = require('@simpleworkjs/conf');
const registry = require('./session_registry');
const metrics = require('../models/metrics');
const { clearInjectedFlag } = require('../utils/key_inject');

// A pass-through that tallies bytes (cheap; one per direction per channel).
function counter(onBytes) {
	return new Transform({
		transform(chunk, _enc, cb) { onBytes(chunk.length); cb(null, chunk); },
	});
}

// Connect the upstream ssh2.Client, retrying once after a short pause if the
// first attempt fails auth (SSSD/AuthorizedKeysCommand cache lag right after a
// first-time key injection).
function connectUpstream({ host, port, username, privateKey, onHostKey, uid, justInjected }) {
	return new Promise((resolve, reject) => {
		let attempted = false;
		const dial = (allowRetry) => {
			const client = new Client();
			client
				.on('ready', () => resolve(client))
				.on('error', async (err) => {
					const authish = /authentication|All configured authentication methods failed/i.test(err.message || '');
					if (authish && allowRetry) {
						attempted = true;
						await clearInjectedFlag(uid).catch(() => {});
						setTimeout(() => dial(false), 2000);
						return;
					}
					reject(err);
				})
				.connect({
					host, port, username, privateKey,
					readyTimeout: (conf.ssh && conf.ssh.connectTimeoutMs) || 10000,
					keepaliveInterval: 15000,
					hostVerifier: (key) => {
						const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
						if (onHostKey) onHostKey(fp);
						return true; // v1: trust-on-use, fingerprint audited. Pinning = follow-up.
					},
				});
		};
		dial(justInjected); // only bother retrying if we just wrote the key
	});
}

// Wire an inbound session (the ssh2 Server 'session' accept() result) to the
// upstream client. Session handlers are attached SYNCHRONOUSLY (call this the
// moment the session is accepted) so channel requests the client sends before
// the upstream connection is ready aren't auto-rejected: pty/env/window-change
// are buffered, and shell/exec/subsystem accept the inbound channel then wait
// on `upstreamPromise` before opening the matching upstream channel.
//
// upstreamPromise resolves to the ready ssh2.Client, or rejects (target
// unreachable) — in which case pending channels get a friendly message.
function attachSession(session, upstreamPromise, audit) {
	let ptyInfo = null;
	const env = {};
	let bytesIn = 0, bytesOut = 0;
	let upstreamStream = null;

	session.on('pty', (accept, _reject, info) => { ptyInfo = info; accept && accept(); });
	session.on('env', (accept, _reject, info) => { env[info.key] = info.val; accept && accept(); });
	session.on('window-change', (accept, _reject, info) => {
		if (upstreamStream) upstreamStream.setWindow(info.rows, info.cols, info.height, info.width);
		accept && accept();
	});

	const pipeStreams = (inbound, up, channel) => {
		audit.patch({ channel });
		upstreamStream = up;
		up.pipe(counter((n) => { bytesOut += n; })).pipe(inbound);
		inbound.pipe(counter((n) => { bytesIn += n; })).pipe(up);
		up.on('exit', (code, signal) => {
			if (!signal && inbound.exit) inbound.exit(code == null ? 0 : code);
		});
		up.on('close', () => { audit.event.bytesIn = bytesIn; audit.event.bytesOut = bytesOut; inbound.close && inbound.close(); });
		inbound.on('close', () => { up.end && up.end(); });
	};

	const withUpstream = (inbound, open) => {
		upstreamPromise.then((up) => open(up)).catch((err) => {
			try { inbound.stderr && inbound.stderr.write(`jump-host: ${err.message}\r\n`); } catch (_) {}
			try { inbound.exit && inbound.exit(1); inbound.close(); } catch (_) {}
		});
	};

	session.on('shell', (accept) => {
		const inbound = accept();
		withUpstream(inbound, (upstream) => {
			upstream.shell(ptyInfo || false, { env }, (err, up) => {
				if (err) { try { inbound.stderr.write(`jump-host: upstream shell failed: ${err.message}\r\n`); inbound.exit(1); inbound.close(); } catch (_) {} return; }
				pipeStreams(inbound, up, 'shell');
			});
		});
	});

	session.on('exec', (accept, _reject, info) => {
		const inbound = accept();
		withUpstream(inbound, (upstream) => {
			upstream.exec(info.command, { pty: ptyInfo || undefined, env }, (err, up) => {
				if (err) { try { inbound.stderr.write(`jump-host: upstream exec failed: ${err.message}\r\n`); inbound.exit(1); inbound.close(); } catch (_) {} return; }
				pipeStreams(inbound, up, 'exec');
			});
		});
	});

	session.on('subsystem', (accept, reject, info) => {
		if (info.name !== 'sftp') return reject && reject();
		const inbound = accept();
		withUpstream(inbound, (upstream) => {
			upstream.subsys('sftp', (err, up) => {
				if (err) { try { inbound.close(); } catch (_) {} return; }
				pipeStreams(inbound, up, 'sftp');
			});
		});
	});
}

// TUI mode: the picker already opened one inbound shell channel. Bridge THAT
// channel directly to an upstream shell (no waiting for further channel
// requests). window-change from the client is forwarded via the session.
function bridgeShellChannel(inbound, upstream, ptyInfo, audit) {
	return new Promise((resolve, reject) => {
		upstream.shell(ptyInfo || false, {}, (err, up) => {
			if (err) return reject(err);
			audit.patch({ channel: 'shell' });
			let bytesIn = 0, bytesOut = 0;
			up.pipe(counter((n) => { bytesOut += n; })).pipe(inbound);
			inbound.pipe(counter((n) => { bytesIn += n; })).pipe(up);
			up.on('exit', (code) => { try { inbound.exit(code == null ? 0 : code); } catch (_) {} });
			up.on('close', () => { audit.event.bytesIn = bytesIn; audit.event.bytesOut = bytesOut; try { inbound.close(); } catch (_) {} });
			inbound.on('close', () => { try { up.end(); } catch (_) {} });
			resolve({ upstreamStream: up, counters: () => ({ bytesIn, bytesOut }) });
		});
	});
}

module.exports = { connectUpstream, attachSession, bridgeShellChannel, counter, registry, metrics };
