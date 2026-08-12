'use strict';

// The mesh CONTROL state: this gateway's WireGuard identity, its own mesh
// index, and the job of making the live wg interface agree with the registry
// in Redis.
//
// This exists because the registry is durable and the interface is not. Peers
// live in Redis (models/mesh_gateway.js); the wg-mesh interface lives in the
// container's network namespace and is gone the moment the container
// restarts. Nothing used to rebuild it -- ensureInterface/setPrivateKey/
// setAddress/setPeer were only ever called from routes/mesh.js, i.e. only
// while an admin was actively minting a token or joining. So after any
// restart the mesh was silently down (registry full of peers, interface
// absent) until someone re-ran a join by hand, and the only symptom was
// mesh_forwarder logging EADDRNOTAVAIL on its ingress bind every 30s.
//
// reconcileMesh() replays the registry onto the interface and is the single
// place that knows how to do it -- called at boot (bin/www) and after every
// mesh change, so the routes no longer hand-roll the same four calls in two
// slightly different orders.

const conf = require('@simpleworkjs/conf');
const meshGateway = require('../models/mesh_gateway');
const wgIface = require('../utils/wg_iface');
const wgKeys = require('../utils/wg_keys');
const { meshCidrFor, meshAllowedIpsFor } = require('../utils/mesh_addressing');

const IFACE = process.env.THETA_MESH_IFACE || 'wg-mesh';
const MESH_LISTEN_PORT = process.env.THETA_MESH_LISTEN_PORT || 51820;

// Marks this gateway's own entry in the registry. Kept for display only --
// never trusted for identity, see selfEntry().
const SELF_SLUG = '(self)';

function localIdentity() {
	// wg_bootstrap.js normally populates this at startup; generate on demand
	// so the mesh routes still work in an environment where it hasn't run.
	if (!conf.wireguard) conf.wireguard = {};
	if (!conf.wireguard.serverPublicKey || !conf.wireguard.serverPrivateKey) {
		const kp = wgKeys.generateKeypair();
		conf.wireguard.serverPublicKey = kp.publicKey;
		conf.wireguard.serverPrivateKey = kp.privateKey;
	}
	return conf.wireguard;
}

// Which registry entry is US. Matched on public key, NOT on siteSlug: the
// slug arrives in the REMOTE's POST /register body, so a peer that registers
// itself as '(self)' would otherwise be mistaken for this gateway -- enough
// to make mesh_forwarder bind its ingress listener to the peer's mesh address
// instead of ours, and to make that peer undeletable through
// DELETE /api/mesh/gateways/:id. The keypair is ours alone and never crosses
// the wire, so it is the only trustworthy discriminator.
function selfEntry(gateways, publicKey) {
	const key = publicKey || (conf.wireguard && conf.wireguard.serverPublicKey);
	if (!key) return null;
	return gateways.find((g) => g.publicKey === key) || null;
}

// This gateway's own mesh index is "the lowest free index, stable once
// picked", stored as a self-entry in the same registry so it survives
// restarts exactly the way peer entries do.
async function ensureOwnMeshIndex(explicitMeshIndex) {
	const self = localIdentity();
	const existing = await meshGateway.findByPublicKey(self.serverPublicKey);
	if (existing) return existing.meshIndex;
	const created = await meshGateway.register({
		publicKey: self.serverPublicKey,
		endpoint: self.serverEndpoint || '',
		siteSlug: SELF_SLUG,
		meshIndex: explicitMeshIndex
	});
	return created.meshIndex;
}

function applyPeer(peer) {
	wgIface.setPeer(IFACE, {
		publicKey: peer.publicKey,
		endpoint: peer.endpoint,
		allowedIPs: meshAllowedIpsFor(Number(peer.meshIndex)),
		keepalive: 25
	});
}

// Bring the interface up and give it this gateway's key, port, and address.
// Idempotent -- every call re-asserts the same state, which is what makes it
// safe to run at boot AND after each mesh change.
async function ensureInterfaceFor(ownMeshIndex) {
	const self = localIdentity();
	await wgIface.ensureInterface(IFACE);
	wgIface.setPrivateKey(IFACE, self.serverPrivateKey, MESH_LISTEN_PORT);
	wgIface.setAddress(IFACE, meshCidrFor(Number(ownMeshIndex)));
}

/**
 * Decide what the interface SHOULD look like, given a registry snapshot.
 * Pure -- no I/O -- so the rules below are cheaply testable apart from the
 * `wg`/`ip` calls that carry them out (same split as utils/mesh_addressing).
 *
 * A gateway with no self-entry has never meshed with anyone: nothing to
 * rebuild, and no interface should be created, since an unmeshed gateway has
 * no business holding a WireGuard device open.
 *
 * @returns {{joined: boolean, meshIndex: number|null, address: string|null, peers: Array}}
 */
function planReconcile(gateways, publicKey) {
	const self = selfEntry(gateways, publicKey);
	if (!self || !self.meshIndex) {
		return { joined: false, meshIndex: null, address: null, peers: [] };
	}

	const peers = gateways
		.filter((g) => g.id !== self.id)
		// An entry missing either field cannot produce a valid peer -- it would
		// throw inside assertValidIndex or be rejected by `wg` -- so drop it
		// here rather than fail the whole reconcile over one bad row.
		.filter((g) => g.publicKey && g.meshIndex)
		.map((g) => ({
			id: g.id,
			siteSlug: g.siteSlug,
			publicKey: g.publicKey,
			endpoint: g.endpoint,
			meshIndex: Number(g.meshIndex),
			allowedIPs: meshAllowedIpsFor(Number(g.meshIndex))
		}));

	return { joined: true, meshIndex: self.meshIndex, address: meshCidrFor(Number(self.meshIndex)), peers };
}

/**
 * Rebuild the live wg-mesh interface from the registry.
 * @returns {{joined: boolean, meshIndex: number|null, peers: number, failed: Array}}
 */
async function reconcileMesh() {
	const plan = planReconcile(await meshGateway.list());
	if (!plan.joined) return { joined: false, meshIndex: null, peers: 0, failed: [] };

	await ensureInterfaceFor(plan.meshIndex);

	const failed = [];
	let peers = 0;
	for (const peer of plan.peers) {
		// One bad entry must not stop the rest of the mesh coming back up.
		try {
			applyPeer(peer);
			peers++;
		} catch (err) {
			failed.push({ id: peer.id, siteSlug: peer.siteSlug, error: err.message });
			console.error(`[mesh] could not restore peer ${peer.siteSlug || peer.id}: ${err.message}`);
		}
	}

	console.log(`[mesh] reconciled: site index ${plan.meshIndex}, ${peers} peer(s) applied` +
		(failed.length ? `, ${failed.length} failed` : ''));
	return { joined: true, meshIndex: plan.meshIndex, peers, failed };
}

module.exports = {
	IFACE, MESH_LISTEN_PORT, SELF_SLUG,
	localIdentity, selfEntry, ensureOwnMeshIndex,
	ensureInterfaceFor, applyPeer, planReconcile, reconcileMesh
};
