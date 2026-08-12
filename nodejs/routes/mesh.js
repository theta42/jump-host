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
// Reconciled after every mesh change so a newly-meshed (or removed) peer
// becomes reachable (or stops being reachable) without a gateway restart --
// see services/mesh_forwarder.js for what these listeners actually bridge.
const { syncMeshForwarders } = require('../services/mesh_forwarder');
// Identity, own-index, and interface application all live in mesh_state so
// that boot-time reconciliation and these routes drive the interface through
// exactly the same code -- they used to hand-roll the same four wgIface calls
// in two slightly different orders.
const meshState = require('../services/mesh_state');
const { MESH_SERVICE_PORT_BASE } = require('../services/mesh_forwarder');
const { meshCidrFor } = require('../utils/mesh_addressing');

const router = express.Router();
const { IFACE } = meshState;

// Live tunnel state, keyed by peer public key. Empty when the interface does
// not exist -- which is itself the answer the UI needs to show ("mesh is
// configured but the interface is down").
function livePeerStatus() {
	if (!wgIface.interfaceExists(IFACE)) return { up: false, peers: {} };
	return { up: true, peers: wgIface.peerStatus(IFACE) };
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

		const self = meshState.localIdentity();
		// A gateway cannot be its own peer: WireGuard would reject the key and
		// the registry entry would collide with the self-entry.
		if (publicKey === self.serverPublicKey) {
			return res.status(400).json({ status: 'error', message: 'a gateway cannot mesh with itself' });
		}

		// This gateway's own mesh index -- assigned to ITSELF the first time
		// anyone registers with it, since a solo gateway has no index yet.
		// Claimed BEFORE the peer's so a fresh gateway keeps the lowest index
		// for itself and the numbering stays stable however it was reached.
		const ownIndex = await meshState.ensureOwnMeshIndex();
		const peer = await meshGateway.register({ publicKey, endpoint, siteSlug });

		await meshState.ensureInterfaceFor(ownIndex);
		meshState.applyPeer(peer);

		syncMeshForwarders().catch((e) => console.error('[mesh] forwarder sync failed:', e.message));

		res.json({
			status: 'ok',
			meshIndex: peer.meshIndex,
			gateway: {
				publicKey: self.serverPublicKey,
				endpoint: self.serverEndpoint || '',
				siteSlug: process.env.SITE_SLUG || '',
				meshIndex: ownIndex
			}
		});
	} catch (e) { next(e); }
});

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

		const self = meshState.localIdentity();

		// A gateway belongs to exactly ONE mesh. Mesh indexes are handed out by
		// whichever gateway you register with, from ITS OWN registry, so two
		// meshes have two unrelated index spaces and cannot be merged without a
		// coordinator that does not exist. Joining a second one used to
		// "succeed": setAddress below would readdress the interface to the new
		// mesh's index while register() kept the old self-entry (it is
		// upsert-by-publicKey and reuses the existing index, ignoring the
		// explicit one), leaving the interface and the registry permanently
		// disagreeing -- mesh_forwarder would then bind ingress to an address
		// no longer on the interface and fail forever.
		const existingSelf = await meshGateway.findByPublicKey(self.serverPublicKey);

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
		if (!data.gateway || !data.gateway.publicKey || !data.gateway.meshIndex) {
			return res.status(502).json({ status: 'error', message: 'remote returned no usable gateway identity' });
		}
		// Without an endpoint for the remote there is nothing to dial: the peer
		// entry would be created, the handshake would never be initiated from
		// this side, and the tunnel would appear configured but dead. Say so
		// instead (the remote needs app_wireguard__serverEndpoint set).
		if (!data.gateway.endpoint) {
			return res.status(502).json({
				status: 'error',
				message: 'remote gateway reported no WireGuard endpoint — set app_wireguard__serverEndpoint on it and retry'
			});
		}
		if (existingSelf && existingSelf.meshIndex !== data.meshIndex) {
			return res.status(409).json({
				status: 'error',
				message: `this gateway is already in a mesh as site index ${existingSelf.meshIndex}; ` +
					`the remote assigned index ${data.meshIndex}. A gateway can only belong to one mesh — ` +
					'remove its existing peers first if you mean to move it.'
			});
		}

		// Persist OUR OWN identity too, not just the remote peer's -- the
		// receiving side of /register does this via ensureOwnMeshIndex(), but
		// the initiating side (here) never did, so GET /api/mesh/self and the
		// mesh UI's own-entry handling both silently saw nothing on whichever
		// gateway called /join.
		await meshState.ensureOwnMeshIndex(data.meshIndex);
		await meshState.ensureInterfaceFor(data.meshIndex);

		// meshIndex is passed EXPLICITLY. The remote assigned itself that index
		// and it is the one actually configured on the live interface; letting
		// register() auto-assign from this gateway's own registry instead
		// invents an unrelated number. That number only happened to agree in
		// the two-gateway case (self takes 1, next free is 2, remote really is
		// 2) and diverges the moment a third gateway exists -- and since
		// mesh_forwarder derives its egress port from the stored index, the
		// forwarder would then listen on a port nobody dials and point it at a
		// site that may not exist.
		const peer = await meshGateway.register({
			publicKey: data.gateway.publicKey,
			endpoint: data.gateway.endpoint,
			siteSlug: data.gateway.siteSlug || '(remote master)',
			meshIndex: data.gateway.meshIndex
		});
		meshState.applyPeer(peer);

		syncMeshForwarders().catch((e) => console.error('[mesh] forwarder sync failed:', e.message));

		res.json({ status: 'ok', meshIndex: data.meshIndex, peerMeshIndex: data.gateway.meshIndex });
	} catch (e) { next(e); }
});

// This gateway's own mesh address, for a LOCAL bootstrap script to discover
// (e.g. theta-suite's site-join, running on the same host as this gateway)
// without needing full jump-admin session auth -- any valid jmp_ API token
// (middleware.auth, no requireJumpAdmin) is enough, same service-to-service
// pattern as theta-proxy's prx_ tokens for proxy_client.js. Not a peer
// listing, so no admin-only audit/config data is exposed here.
router.get('/self', middleware.auth, async (req, res, next) => {
	try {
		const self = conf.wireguard || {};
		let meshIp = null;
		if (self.serverPublicKey) {
			const entry = await meshGateway.findByPublicKey(self.serverPublicKey);
			if (entry) meshIp = meshCidrFor(entry.meshIndex).split('/')[0];
		}
		res.json({ status: 'ok', meshIp, joined: !!meshIp, iface: IFACE });
	} catch (e) { next(e); }
});

router.get('/gateways', middleware.auth, middleware.requireJumpAdmin, async (req, res, next) => {
	try {
		const gateways = await meshGateway.list();
		const self = meshState.selfEntry(gateways);
		// `self` is flagged from the public key rather than left to the UI to
		// infer from siteSlug, which a registering peer controls.
		const decorated = gateways.map((g) => ({
			...g,
			isSelf: !!(self && g.id === self.id),
			meshIp: g.meshIndex ? meshCidrFor(Number(g.meshIndex)).split('/')[0] : null,
			servicePort: g.meshIndex ? MESH_SERVICE_PORT_BASE + Number(g.meshIndex) : null
		}));
		res.json({
			status: 'ok',
			gateways: decorated,
			iface: IFACE,
			kernelWireguard: wgIface.kernelWireguardAvailable(),
			live: livePeerStatus()
		});
	} catch (e) { next(e); }
});

// Re-apply the registry to the live interface on demand. Boot does this
// automatically (bin/www); this is the manual escape hatch for an operator
// looking at a mesh whose interface has drifted -- and the button that makes
// "the tunnel is down but the peers are all listed" fixable from the UI.
router.post('/reconcile', middleware.auth, middleware.requireJumpAdmin, async (req, res, next) => {
	try {
		const result = await meshState.reconcileMesh();
		await syncMeshForwarders();
		res.json({ status: 'ok', ...result });
	} catch (e) { next(e); }
});

// Remove a peer gateway: tears down its local WG peer entry + kernel routes
// (wgIface.removePeer) and drops it from the registry. Does NOT reach out to
// the remote gateway to remove the reciprocal peer entry there -- an admin
// on that side needs to do the same. Refuses to remove this gateway's own
// self-entry, since that's its identity in the mesh, not a peer.
router.delete('/gateways/:id', middleware.auth, middleware.requireJumpAdmin, async (req, res, next) => {
	try {
		const gateways = await meshGateway.list();
		const target = gateways.find((g) => g.id === req.params.id);
		if (!target) return res.status(404).json({ status: 'error', message: 'gateway not found' });
		// Compared by public key, not by the '(self)' slug: the slug comes from
		// the remote's own /register body, so a peer could previously send
		// siteSlug='(self)' and make itself permanently undeletable here.
		const self = meshState.selfEntry(gateways);
		if (self && target.id === self.id) {
			return res.status(400).json({ status: 'error', message: 'cannot remove this gateway\'s own self-entry' });
		}

		wgIface.removePeer(IFACE, target.publicKey);
		await meshGateway.remove(target.id);

		syncMeshForwarders().catch((e) => console.error('[mesh] forwarder sync failed:', e.message));

		res.json({ status: 'ok', removed: { id: target.id, siteSlug: target.siteSlug, meshIndex: target.meshIndex } });
	} catch (e) { next(e); }
});

module.exports = router;
