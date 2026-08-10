'use strict';

// Gateway-to-gateway WireGuard mesh — real site-to-site tunnels, not the
// roaming-client/exit-node feature in routes/wireguard.js. Two gateways mesh
// by one calling the other's POST /api/mesh/register with a join token; both
// sides end up with a live wg0 peer entry for the other, addressed per
// MULTI_SITE_SPEC.md's one-octet mesh index (172.24.<idx>.0/16,
// 10.<idx>.0.0/16, idx 1-254, assigned by whichever gateway is registering
// the caller).
//
// Local interface name is fixed at THETA_MESH_IFACE (default wg-mesh) —
// deliberately separate from the roaming-client interface so the two
// features never fight over the same wg0.

const express = require('express');
const middleware = require('../middleware/auth');
const conf = require('@simpleworkjs/conf');
const meshGateway = require('../models/mesh_gateway');
const meshJoinToken = require('../utils/mesh_join_token');
const wgIface = require('../utils/wg_iface');
const wgKeys = require('../utils/wg_keys');
const { meshCidrFor, meshAllowedIpsFor } = require('../utils/mesh_addressing');

const router = express.Router();
const IFACE = process.env.THETA_MESH_IFACE || 'wg-mesh';
const MESH_LISTEN_PORT = process.env.THETA_MESH_LISTEN_PORT || 51820;

async function ensureLocalIdentity() {
	if (!conf.wireguard) conf.wireguard = {};
	if (!conf.wireguard.serverPublicKey || !conf.wireguard.serverPrivateKey) {
		// wg_bootstrap.js normally does this at startup; guard here too so this
		// route works even if bootstrap hasn't run yet in a given environment.
		const kp = wgKeys.generateKeypair();
		conf.wireguard.serverPublicKey = kp.publicKey;
		conf.wireguard.serverPrivateKey = kp.privateKey;
	}
	return conf.wireguard;
}

// Mint a single-use mesh join token — the credential a NEW gateway presents
// to register into THIS gateway's mesh.
router.post('/join-tokens', middleware.auth, middleware.requireJumpAdmin, async (req, res, next) => {
	try {
		const { token, expiresInSeconds } = await meshJoinToken.mint();
		res.json({ status: 'ok', token, expiresInSeconds });
	} catch (e) { next(e); }
});

// Called by a REMOTE gateway to register itself into THIS gateway's mesh.
// Bearer mesh join token, no admin session (service-to-service, same as
// theta-directory's POST /api/site/register-spoke pattern).
router.post('/register', async (req, res, next) => {
	try {
		const auth = req.headers.authorization || '';
		const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
		if (!(await meshJoinToken.consume(token))) {
			return res.status(401).json({ status: 'error', message: 'invalid or already-used mesh join token' });
		}

		const { publicKey, endpoint, siteSlug } = req.body || {};
		if (!publicKey || !endpoint) {
			return res.status(400).json({ status: 'error', message: 'publicKey and endpoint are required' });
		}

		const self = await ensureLocalIdentity();
		const peer = await meshGateway.register({ publicKey, endpoint, siteSlug });

		await wgIface.ensureInterface(IFACE);
		wgIface.setPrivateKey(IFACE, self.serverPrivateKey, MESH_LISTEN_PORT);
		// This gateway's own mesh index -- assigned to ITSELF the first time
		// anyone registers with it, since a solo gateway has no index yet.
		const ownIndex = await ensureOwnMeshIndex();
		wgIface.setAddress(IFACE, meshCidrFor(ownIndex));
		wgIface.setPeer(IFACE, {
			publicKey: peer.publicKey,
			endpoint: peer.endpoint,
			allowedIPs: meshAllowedIpsFor(peer.meshIndex),
			keepalive: 25
		});

		res.json({
			status: 'ok',
			meshIndex: peer.meshIndex,
			gateway: {
				publicKey: conf.wireguard.serverPublicKey,
				endpoint: conf.wireguard.serverEndpoint || '',
				meshIndex: ownIndex
			}
		});
	} catch (e) { next(e); }
});

// This gateway's own mesh index is just "the lowest free index, stable once
// picked" -- stored as a synthetic self-entry in the same registry so it
// survives restarts the same way peer entries do.
async function ensureOwnMeshIndex() {
	const self = await meshGateway.findByPublicKey(conf.wireguard.serverPublicKey);
	if (self) return self.meshIndex;
	const created = await meshGateway.register({
		publicKey: conf.wireguard.serverPublicKey,
		endpoint: conf.wireguard.serverEndpoint || '',
		siteSlug: '(self)'
	});
	return created.meshIndex;
}

// Admin-initiated: join THIS gateway into a remote gateway's mesh. Generates
// (or reuses) this gateway's identity, brings up the local interface, calls
// the remote's /register, and applies the peer it gets back -- so after this
// call both sides have a live, working wg0 peer entry for each other.
router.post('/join', middleware.auth, middleware.requireJumpAdmin, async (req, res, next) => {
	try {
		const { remoteEndpoint, joinToken } = req.body || {};
		if (!remoteEndpoint || !joinToken) {
			return res.status(400).json({ status: 'error', message: 'remoteEndpoint and joinToken are required' });
		}

		const self = await ensureLocalIdentity();
		await wgIface.ensureInterface(IFACE);
		wgIface.setPrivateKey(IFACE, self.serverPrivateKey, MESH_LISTEN_PORT);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15000);
		let resp;
		try {
			resp = await fetch(String(remoteEndpoint).replace(/\/+$/, '') + '/api/mesh/register', {
				method: 'POST',
				headers: { Authorization: 'Bearer ' + joinToken, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					publicKey: self.serverPublicKey,
					endpoint: self.serverEndpoint || '',
					siteSlug: process.env.SITE_SLUG || ''
				}),
				signal: controller.signal
			});
		} finally { clearTimeout(timer); }

		if (!resp.ok) {
			const text = (await resp.text().catch(() => '')).slice(0, 300);
			return res.status(502).json({ status: 'error', message: 'remote registration failed: HTTP ' + resp.status + ' ' + text });
		}
		const data = await resp.json();

		wgIface.setAddress(IFACE, meshCidrFor(data.meshIndex));
		await meshGateway.register({ publicKey: data.gateway.publicKey, endpoint: data.gateway.endpoint, siteSlug: '(remote master)' });
		wgIface.setPeer(IFACE, {
			publicKey: data.gateway.publicKey,
			endpoint: data.gateway.endpoint,
			allowedIPs: meshAllowedIpsFor(data.gateway.meshIndex),
			keepalive: 25
		});

		res.json({ status: 'ok', meshIndex: data.meshIndex, peerMeshIndex: data.gateway.meshIndex });
	} catch (e) { next(e); }
});

router.get('/gateways', middleware.auth, middleware.requireJumpAdmin, async (req, res, next) => {
	try {
		const gateways = await meshGateway.list();
		res.json({ status: 'ok', gateways, iface: IFACE, kernelWireguard: wgIface.kernelWireguardAvailable() });
	} catch (e) { next(e); }
});

module.exports = router;
