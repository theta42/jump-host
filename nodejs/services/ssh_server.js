'use strict';

// The public SSH front door. Authenticates the inbound user against LDAP,
// parses the username grammar, resolves the target from the directory (or runs
// the TUI picker), injects the jump host's key for the user, bridges to the
// downstream host, and audits everything.

const { Server, utils: { parseKey } } = require('ssh2');
const conf = require('@simpleworkjs/conf');

const { ensureKeys } = require('../utils/host_keys');
const { parseUsername } = require('../utils/username_grammar');
const { matchTarget, hostEndpoint } = require('../utils/target_match');
const { accessibleHosts } = require('../utils/access');
const { ensureKeyInjected } = require('../utils/key_inject');
const userLdap = require('../models/user_ldap');
const audit = require('../models/audit_event');
const metrics = require('../models/metrics');
const registry = require('./session_registry');
const { pickHost } = require('./tui_picker');
const { connectUpstream, attachSession, bridgeShellChannel } = require('./bridge');

let JUMP_KEYS; // { hostKeys, clientKey, publicLine }

// Is a client address "local" (loopback or RFC1918)? Governs passwordAuth:'local'.
function isLocalAddr(ip) {
	if (!ip) return false;
	const a = ip.replace(/^::ffff:/, '');
	return a === '127.0.0.1' || a === '::1'
		|| /^10\./.test(a) || /^192\.168\./.test(a)
		|| /^172\.(1[6-9]|2\d|3[01])\./.test(a);
}

function passwordAllowed(clientIp) {
	const mode = (conf.ssh && conf.ssh.passwordAuth) || 'local';
	if (mode === 'all') return true;
	if (mode === 'off') return false;
	return isLocalAddr(clientIp); // 'local'
}

// Compare an inbound publickey to the user's LDAP keys, EXCLUDING the jump
// host's own injected key (only the jump host may hold that private half).
function userKeyMatches(user, ctxKey) {
	const marker = conf.ssh.keyComment;
	for (const line of user.sshPublicKeys || []) {
		if (marker && line.trim().endsWith(marker)) continue;
		const parsed = parseKey(line);
		if (parsed instanceof Error) continue;
		const key = Array.isArray(parsed) ? parsed[0] : parsed;
		if (key.type === ctxKey.algo && key.getPublicSSH().equals(ctxKey.data)) return key;
	}
	return null;
}

function handleAuth(ctx, state) {
	(async () => {
		let parsed;
		try {
			parsed = parseUsername(ctx.username);
		} catch (_) {
			return ctx.reject(['publickey', 'password']);
		}
		state.uid = parsed.uid;
		state.target = parsed.target;

		const user = await userLdap.getUser(parsed.uid).catch(() => null);
		if (!user) return ctx.reject(['publickey', 'password']);
		state.user = user;

		if (ctx.method === 'publickey') {
			const key = userKeyMatches(user, ctx.key);
			if (!key) return ctx.reject(['publickey', 'password']);
			// Two-phase: probe (no signature) then verify.
			if (ctx.signature) {
				const ok = key.verify(ctx.blob, ctx.signature, ctx.hashAlgo);
				if (ok !== true) return ctx.reject();
			}
			state.authMethod = 'publickey';
			return ctx.accept();
		}

		if (ctx.method === 'password') {
			if (!passwordAllowed(state.clientIp)) return ctx.reject(['publickey']);
			const ok = await userLdap.checkPassword(user.dn, ctx.password);
			if (!ok) return ctx.reject(['publickey', 'password']);
			state.authMethod = 'password';
			return ctx.accept();
		}

		return ctx.reject(['publickey', 'password']);
	})().catch(() => ctx.reject());
}

// After auth: resolve target (grammar or TUI), inject key, bridge.
async function onReady(client, state) {
	if (registry.count() >= ((conf.ssh && conf.ssh.maxSessions) || 100)) {
		client.end();
		return;
	}

	client.once('session', (accept) => {
		const session = accept();
		runSession(session, client, state).catch(() => {
			try { client.end(); } catch (_) {}
		});
	});
}

async function runSession(session, client, state) {
	// Grammar mode: the client opens its own channels (shell/exec/sftp) right
	// after the session — attach the buffering bridge SYNCHRONOUSLY so no
	// channel request is dropped while we resolve+connect asynchronously.
	if (state.target) return runGrammar(session, client, state);
	return runTuiSession(session, client, state);
}

// Shared: resolve target -> inject key -> connect upstream. Returns
// { upstream, host, endpoint, record } or throws { reason }.
async function resolveAndConnect(state, record, { onHostKey } = {}) {
	const hosts = await accessibleHosts(state.user).catch(() => { throw fail('directory-unreachable'); });

	let host = null, raw = null;
	const m = matchTarget(state.target, hosts, { allowRawIPs: conf.ssh.allowRawIPs });
	host = m.host; raw = m.raw;

	const endpoint = host ? hostEndpoint(host, conf.ssh.defaultPort) : { address: raw, port: conf.ssh.defaultPort };
	if (!endpoint.address) throw fail('no-address');

	await record.patch({ targetSlug: host ? host.slug : 'raw-ip', targetAddr: endpoint.address, targetPort: endpoint.port });

	let justInjected = false;
	try { justInjected = await ensureKeyInjected(state.user, JUMP_KEYS.publicLine); }
	catch (_) { throw fail('key-inject-failed'); }

	let upstream;
	try {
		upstream = await connectUpstream({
			host: endpoint.address, port: endpoint.port,
			username: state.uid, privateKey: JUMP_KEYS.clientKey,
			uid: state.uid, justInjected, onHostKey,
		});
	} catch (_) { throw fail('upstream-unreachable'); }

	return { upstream, host, endpoint };
}

function fail(reason) { const e = new Error(reason); e.reason = reason; return e; }

async function runGrammar(session, client, state) {
	const record = await audit.create({ uid: state.uid, authMethod: state.authMethod, clientIp: state.clientIp, mode: 'grammar' });

	// Deferred upstream — attach the bridge NOW, resolve/reject after connect.
	let resolveUp, rejectUp;
	const upstreamPromise = new Promise((res, rej) => { resolveUp = res; rejectUp = rej; });
	attachSession(session, upstreamPromise, record);

	try {
		const { upstream, host, endpoint } = await resolveAndConnect(state, record, {
			onHostKey: (fp) => record.patch({ hostKeyFp: fp }),
		});
		registry.add(record.id, { uid: state.uid, target: endpoint.address, slug: host ? host.slug : 'raw-ip' });
		await record.patch({ success: true });
		await metrics.bump({ uid: state.uid, hostSlug: host ? host.slug : undefined, success: true });
		resolveUp(upstream);
		wireTeardown(session, client, upstream, record);
	} catch (err) {
		const reason = err.reason || 'error';
		rejectUp(new Error(reasonMessage(reason)));
		await record.finish({ success: false, failReason: reason });
		await metrics.bump({ uid: state.uid, success: false });
	}
}

async function runTuiSession(session, client, state) {
	const record = await audit.create({ uid: state.uid, authMethod: state.authMethod, clientIp: state.clientIp, mode: 'tui' });

	const finishFail = async (reason) => {
		await record.finish({ success: false, failReason: reason });
		await metrics.bump({ uid: state.uid, success: false });
		try { client.end(); } catch (_) {}
	};

	let hosts;
	try { hosts = await accessibleHosts(state.user); }
	catch (_) { return finishFail('directory-unreachable'); }

	const tui = await runTui(session, state.uid, hosts);
	if (!tui.host) return finishFail('cancelled');
	state.target = tui.host.slug;

	const endpoint = hostEndpoint(tui.host, conf.ssh.defaultPort);
	await record.patch({ targetSlug: tui.host.slug, targetAddr: endpoint.address, targetPort: endpoint.port });

	let justInjected = false;
	try { justInjected = await ensureKeyInjected(state.user, JUMP_KEYS.publicLine); }
	catch (_) { return finishFail('key-inject-failed'); }

	let upstream;
	try {
		upstream = await connectUpstream({
			host: endpoint.address, port: endpoint.port,
			username: state.uid, privateKey: JUMP_KEYS.clientKey,
			uid: state.uid, justInjected, onHostKey: (fp) => record.patch({ hostKeyFp: fp }),
		});
	} catch (_) {
		try { tui.channel.write(`\r\n  Could not reach ${endpoint.address}.\r\n`); tui.channel.close(); } catch (_) {}
		return finishFail('upstream-unreachable');
	}

	registry.add(record.id, { uid: state.uid, target: endpoint.address, slug: tui.host.slug });
	await record.patch({ success: true });
	await metrics.bump({ uid: state.uid, hostSlug: tui.host.slug, success: true });

	let upstreamStream;
	session.on('window-change', (accept, _reject, info) => {
		if (upstreamStream) upstreamStream.setWindow(info.rows, info.cols, info.height, info.width);
		accept && accept();
	});
	try {
		const r = await bridgeShellChannel(tui.channel, upstream, tui.ptyInfo, record);
		upstreamStream = r.upstreamStream;
	} catch (err) {
		try { tui.channel.write(`\r\n  Upstream shell failed: ${err.message}\r\n`); tui.channel.close(); } catch (_) {}
	}
	wireTeardown(session, client, upstream, record);
}

function wireTeardown(session, client, upstream, record) {
	upstream.on('close', async () => {
		registry.remove(record.id);
		await record.finish({ success: true });
	});
	client.on('close', () => { try { upstream.end(); } catch (_) {} });
}

function reasonMessage(reason) {
	return {
		'no-such-target': 'no host you can access matches that target',
		'no-access': 'you do not have access to that host',
		'directory-unreachable': 'directory service unavailable',
		'upstream-unreachable': 'could not reach the target host',
		'key-inject-failed': 'could not provision your access key',
	}[reason] || reason;
}

// Run the TUI picker over a shell channel; returns { host, channel, ptyInfo }.
// host is null if the user quit. exec/subsystem in picker mode are rejected.
function runTui(session, uid, hosts) {
	return new Promise((resolve) => {
		let ptyInfo = null;
		let settled = false;
		const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

		session.on('pty', (accept, _reject, info) => { ptyInfo = info; accept && accept(); });
		session.on('shell', (accept) => {
			const channel = accept();
			pickHost(channel, uid, hosts).then((host) => {
				if (!host) { try { channel.write('\r\n  Bye.\r\n'); channel.close(); } catch (_) {} }
				finish({ host, channel, ptyInfo });
			});
		});
		session.on('exec', (accept) => {
			const c = accept();
			try { c.stderr.write('jump-host: interactive login required to pick a host (or use uid_-_target)\r\n'); c.exit(1); c.close(); } catch (_) {}
			finish({ host: null });
		});
		session.on('subsystem', (accept, reject) => { reject && reject(); finish({ host: null }); });
	});
}

function start() {
	JUMP_KEYS = ensureKeys();
	const server = new Server(
		{ hostKeys: JUMP_KEYS.hostKeys, banner: (conf.ssh && conf.ssh.banner) || undefined },
		(client, info) => {
			const state = { clientIp: (info && info.ip) || null };
			client.on('authentication', (ctx) => handleAuth(ctx, state));
			client.on('ready', () => onReady(client, state));
			client.on('error', () => {});
		}
	);

	const port = (conf.ssh && conf.ssh.listenPort) || 2222;
	const host = (conf.ssh && conf.ssh.listenHost) || '0.0.0.0';
	server.listen(port, host, () => {
		console.log(`[ssh] jump host listening on ${host}:${server.address().port}`);
	});
	return server;
}

module.exports = { start, _internal: { isLocalAddr, passwordAllowed, userKeyMatches } };
