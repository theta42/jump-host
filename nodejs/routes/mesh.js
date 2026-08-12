'use strict';

// Mesh diagnostics and manual reconcile.
//
// There is deliberately NO join flow here any more. A gateway does not
// negotiate its own peering: it belongs to a site, that site joined a
// directory, and the directory hands out the one cluster-unique number
// (siteId, which IS the site's LDAP ServerID) plus the roster of everyone
// else. Joining the directory IS joining the mesh -- one flow instead of two,
// and no second allocator to disagree with the first.
//
// So this router only answers "what is this gateway actually doing right now"
// and "apply the roster again". All configuration lives in the directory's UI.

const express = require('express');
const middleware = require('../middleware/auth');
const wgIface = require('../utils/wg_iface');
const netRouter = require('../utils/net_router');
const meshState = require('../services/mesh_state');
const exitRouter = require('../services/exit_router');
const directory = require('../services/directory_client');
const { meshIp, siteCidr } = require('../utils/mesh_addressing');

const router = express.Router();
const { IFACE } = meshState;

// Live tunnel state straight from the kernel. The registry says what SHOULD
// exist; this says what does.
function liveState() {
	if (!wgIface.interfaceExists(IFACE)) return { up: false, peers: {} };
	return { up: true, peers: wgIface.peerStatus(IFACE) };
}

// This gateway's own mesh address, for a local bootstrap script to discover
// without a full admin session -- any valid jmp_ API token is enough, the same
// service-to-service pattern theta-proxy's prx_ tokens use.
router.get('/self', middleware.auth, async (req, res, next) => {
	try {
		const peers = await directory.fetchPeers();
		const siteId = peers.value && peers.value.localSiteId;
		res.json({
			status: 'ok',
			siteId: siteId || null,
			meshIp: siteId ? meshIp(siteId) : null,
			siteCidr: siteId ? siteCidr(siteId) : null,
			joined: !!siteId,
			iface: IFACE,
			stale: peers.stale
		});
	} catch (e) { next(e); }
});

// Everything this gateway believes about its own networking, in one place --
// what the roster says, what is actually on the interface, and whether the two
// agree. Built for the "the tunnel is up but nothing crosses it" question.
router.get('/status', middleware.auth, middleware.requireJumpAdmin, async (req, res, next) => {
	try {
		const [peers, clients, roster] = await Promise.all([
			directory.fetchPeers(), directory.fetchSiteClients(), directory.fetchRoster()
		]);
		const siteId = peers.value && peers.value.localSiteId;
		const site = roster.value && (roster.value.sites || []).find((s) => Number(s.siteId) === Number(siteId));
		const plan = peers.value ? meshState.planReconcile(peers.value, clients.value, site) : { ready: false, peers: [], netmaps: [] };
		const live = liveState();
		// Exits are separate interfaces, so their health is separate too -- a
		// working mesh with a dead exit is a real and confusing state.
		const exitPlan = exitRouter.planExits(
			(clients.value && clients.value.clients) || [],
			(roster.value && roster.value.sites) || [],
			siteId
		);

		res.json({
			status: 'ok',
			iface: IFACE,
			listenPort: meshState.LISTEN_PORT,
			kernelWireguard: wgIface.kernelWireguardAvailable(),
			wanInterface: netRouter.detectWanInterface(),
			netmapAvailable: netRouter.netmapAvailable(),
			endpoint: meshState.localEndpoint(),
			site: site || null,
			siteId: siteId || null,
			// True when the directory could not be reached and this is cached
			// config -- the difference between "correct" and "last known good".
			stale: peers.stale,
			directoryError: peers.error,
			planned: {
				addresses: plan.addresses || [],
				peers: (plan.peers || []).map((p) => ({
					kind: p.kind, label: p.label, publicKey: p.publicKey,
					endpoint: p.endpoint, allowedIPs: p.allowedIPs,
					exitSiteId: p.exitSiteId === undefined ? null : p.exitSiteId
				})),
				netmaps: plan.netmaps || [],
				exits: exitPlan.exits.map((e) => ({
					siteId: e.siteId, slug: e.slug, iface: e.iface, table: e.table, endpoint: e.endpoint
				})),
				exitRules: exitPlan.rules,
				// Devices pointed at an exit that cannot be built, and why.
				exitProblems: exitPlan.unusable
			},
			live,
			exitLive: exitRouter.exitStatus()
		});
	} catch (e) { next(e); }
});

// Re-apply the roster now. The gateway does this at boot and on a timer; this
// is the button for an operator who has just changed something and does not
// want to wait for the next pass.
router.post('/reconcile', middleware.auth, middleware.requireJumpAdmin, async (req, res, next) => {
	try {
		res.json({ status: 'ok', ...(await meshState.reconcileMesh()) });
	} catch (e) { next(e); }
});

module.exports = router;
