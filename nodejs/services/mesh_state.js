'use strict';

// Turning the directory's roster into a working router.
//
// This gateway is authoritative for its own site's network and for nothing
// else. It publishes the two facts only it knows -- its WireGuard public key
// and the endpoint peers dial -- and reads everything else (which sites exist,
// what this site's LAN and resolver are, which devices belong here, where each
// one exits) from the directory. So all configuration happens in one UI, and
// no gateway can rewrite another gateway's network.
//
// ONE interface carries both site peers and local client devices. Their
// AllowedIPs cannot collide: a site peer is allowed 172.24.0.<n>/32 plus
// 10.<n>.0.0/16 for OTHER sites, while a local client is a /32 inside THIS
// site's /16, which is never allowed to any peer. WireGuard's longest-prefix
// match sorts out the hub's 10.0.0.0/8 catch-all against both. Splitting them
// would buy separate listen ports and nothing else.
//
// The interface is not persisted anywhere: it dies with a reboot and is
// rebuilt from the roster at startup. That is deliberate -- there is one
// source of truth and one code path that applies it, rather than a
// wg0.conf on disk that drifts from what the directory says.

const conf = require('@simpleworkjs/conf');
const wgIface = require('../utils/wg_iface');
const wgKeys = require('../utils/wg_keys');
const netRouter = require('../utils/net_router');
const directory = require('./directory_client');
const {
	meshAddress, siteGatewayCidr, siteCidr, shadowCidr, SHADOW_SLOTS, assertSiteId
} = require('../utils/mesh_addressing');

const IFACE = process.env.THETA_MESH_IFACE || 'wg-mesh';
const LISTEN_PORT = Number(process.env.THETA_MESH_LISTEN_PORT || 51820);

// Where this gateway's own keypair lives. Generated once, then stable: every
// peer in the cluster holds the public half, so regenerating it silently
// breaks every tunnel until each peer is updated. Rotation is a deliberate,
// cluster-wide operation and is not attempted here.
const KEYPAIR_KEY = () => `${conf.redis.prefix}wg_gateway_keypair`;

async function localIdentity() {
	const { getRedis } = require('../models/index');
	const redis = await getRedis();
	const stored = await redis.hGetAll(KEYPAIR_KEY());
	if (stored && stored.publicKey && stored.privateKey) return stored;

	const kp = wgKeys.generateKeypair();
	const record = { publicKey: kp.publicKey, privateKey: kp.privateKey, createdAt: String(Date.now()) };
	await redis.hSet(KEYPAIR_KEY(), record);
	console.log('[mesh] generated this gateway\'s WireGuard identity');
	return record;
}

/**
 * The endpoint peers should dial to reach this gateway.
 * Empty is legitimate -- a site with no inbound access still reaches the mesh
 * outbound and is reached back through the hub.
 */
function localEndpoint() {
	const explicit = process.env.THETA_MESH_ENDPOINT || (conf.wireguard && conf.wireguard.serverEndpoint);
	if (explicit) return explicit;
	const host = process.env.THETA_PUBLIC_HOST || (conf.domain || '');
	return host ? `${host}:${LISTEN_PORT}` : '';
}

/**
 * Decide the whole interface state from the roster. Pure -- no I/O -- so every
 * rule below is testable without touching `wg`, `ip`, or `iptables`.
 *
 * @param {object} peersDoc   GET /api/mesh/peers
 * @param {object} clientsDoc GET /api/mesh/site-clients
 * @param {object} site       this site's own roster row (LAN, DNS, shadows)
 */
function planReconcile(peersDoc, clientsDoc, site) {
	const siteId = peersDoc && peersDoc.localSiteId;
	if (!siteId) {
		return { ready: false, reason: 'this site has no id yet — it has not joined a directory', peers: [], addresses: [], routes: [], netmaps: [] };
	}
	assertSiteId(siteId);

	// Two addresses: the mesh identity every other gateway knows us by, and
	// this site's router address, which is what local clients and the site's
	// own services use as their way onto the mesh.
	const addresses = [meshAddress(siteId), siteGatewayCidr(siteId)];

	const peers = [];
	for (const peer of (peersDoc.peers || [])) {
		if (!peer.publicKey || !peer.allowedIps || !peer.allowedIps.length) continue;
		peers.push({
			kind: 'site',
			label: peer.slug || `site ${peer.siteId}`,
			publicKey: peer.publicKey,
			endpoint: peer.endpoint || '',
			allowedIPs: peer.allowedIps,
			// Only keepalive toward peers we dial; a peer with no endpoint is
			// one that dials us, and keepalive would have nowhere to go.
			keepalive: peer.endpoint ? 25 : 0
		});
	}

	// Local devices. A client is a single /32 -- it must never be allowed to
	// source traffic for anything but its own address, or one compromised
	// laptop could claim another site's whole /16.
	for (const client of ((clientsDoc && clientsDoc.clients) || [])) {
		if (!client.publicKey || !client.assignedIp) continue;
		peers.push({
			kind: 'client',
			label: `${client.uid}/${client.name}`,
			publicKey: client.publicKey,
			endpoint: '',
			allowedIPs: [`${client.assignedIp}/32`],
			keepalive: 0,
			exitSiteId: client.exitSiteId === undefined ? null : client.exitSiteId
		});
	}

	// The mesh as a whole goes down this interface. Per-peer AllowedIPs decide
	// which tunnel each packet actually takes; these routes just get traffic
	// into WireGuard in the first place.
	const routes = [
		{ cidr: '10.0.0.0/8', dev: IFACE },
		{ cidr: '172.24.0.0/16', dev: IFACE }
	];

	// NETMAP: this site's physical LANs, mapped into shadow /24s so that every
	// site's 192.168.1.0/24 is globally distinct.
	const netmaps = [];
	for (const slot of SHADOW_SLOTS) {
		const physical = site && (slot === 168 ? site.lan168 : site.lan172);
		if (!physical) continue;
		netmaps.push({ slot, shadow: shadowCidr(siteId, slot), physical });
	}

	return { ready: true, siteId, addresses, peers, routes, netmaps, siteCidr: siteCidr(siteId) };
}

/**
 * Apply a plan to the live system. Idempotent at every step, because this runs
 * at boot, after every roster change, and on a timer.
 */
async function applyPlan(plan, identity) {
	await wgIface.ensureInterface(IFACE);
	wgIface.setPrivateKey(IFACE, identity.privateKey, LISTEN_PORT);
	wgIface.setAddresses(IFACE, plan.addresses);

	const failed = [];
	const wanted = new Set();
	for (const peer of plan.peers) {
		wanted.add(peer.publicKey);
		try {
			wgIface.setPeer(IFACE, peer);
		} catch (err) {
			// One bad peer must not stop the rest of the mesh coming up.
			failed.push({ label: peer.label, error: err.message });
			console.error(`[mesh] could not apply peer ${peer.label}: ${err.message}`);
		}
	}

	// Anything on the interface that is no longer in the roster is gone --
	// a removed site or a revoked device must stop being reachable now, not at
	// the next restart.
	for (const existing of wgIface.listPeers(IFACE)) {
		if (!wanted.has(existing)) {
			console.log(`[mesh] removing peer no longer in the roster: ${existing.slice(0, 12)}…`);
			wgIface.removePeer(IFACE, existing);
		}
	}

	for (const route of plan.routes) wgIface.ensureRoute(route.cidr, route.dev);

	// Routing/NAT only makes sense once the interface exists, so it happens
	// here rather than at boot.
	const wan = netRouter.detectWanInterface();
	netRouter.applySysctls([IFACE, wan].filter(Boolean));
	netRouter.applyForwarding(wan, [IFACE]);
	for (const map of plan.netmaps) {
		try {
			netRouter.applyNetmap(IFACE, map.shadow, map.physical);
		} catch (err) {
			failed.push({ label: `netmap ${map.shadow}`, error: err.message });
			console.error(`[mesh] NETMAP ${map.shadow} -> ${map.physical} failed: ${err.message}`);
		}
	}

	return { peers: plan.peers.length - failed.length, failed, wan };
}

/**
 * Full cycle: publish who we are, pull what to build, build it.
 *
 * Publishing is best-effort. A gateway that cannot reach the directory must
 * still configure itself from cache -- these are deployments where the
 * directory may be a container on the same box that is being restarted, and
 * tunnels must not drop because a web app is.
 */
async function reconcileMesh() {
	const identity = await localIdentity();

	try {
		await directory.publishSelf({
			gatewayPublicKey: identity.publicKey,
			gatewayEndpoint: localEndpoint()
		});
	} catch (err) {
		console.warn(`[mesh] could not publish this gateway's identity: ${err.message}`);
	}

	const peersRes = await directory.fetchPeers();
	if (!peersRes.value) {
		console.error(`[mesh] no peer config available (${peersRes.error}); leaving the interface untouched`);
		return { ready: false, reason: peersRes.error, stale: true };
	}
	const clientsRes = await directory.fetchSiteClients();
	const rosterRes = await directory.fetchRoster();
	const site = rosterRes.value && (rosterRes.value.sites || []).find((s) => Number(s.siteId) === Number(peersRes.value.localSiteId));

	const plan = planReconcile(peersRes.value, clientsRes.value, site);
	if (!plan.ready) {
		console.warn(`[mesh] not configuring: ${plan.reason}`);
		return { ready: false, reason: plan.reason, stale: peersRes.stale };
	}

	const result = await applyPlan(plan, identity);
	console.log(`[mesh] site ${plan.siteId}: ${result.peers} peer(s), ${plan.netmaps.length} NETMAP(s), WAN ${result.wan || 'none'}` +
		(peersRes.stale ? ' (from cached config — directory unreachable)' : ''));
	return { ready: true, siteId: plan.siteId, ...result, stale: peersRes.stale };
}

let timer = null;

function startMeshReconcile({ intervalMs = 60000 } = {}) {
	reconcileMesh().catch((err) => console.error('[mesh] initial reconcile failed:', err.message));
	if (timer) clearInterval(timer);
	timer = setInterval(() => {
		reconcileMesh().catch((err) => console.error('[mesh] reconcile failed:', err.message));
	}, intervalMs);
	if (timer.unref) timer.unref();
}

function stopMeshReconcile() {
	if (timer) clearInterval(timer);
	timer = null;
}

module.exports = {
	IFACE, LISTEN_PORT,
	localIdentity, localEndpoint, planReconcile, applyPlan, reconcileMesh,
	startMeshReconcile, stopMeshReconcile
};
