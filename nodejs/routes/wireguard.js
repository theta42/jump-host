'use strict';

// WireGuard management API — admin-gated.
//
// Sites  (exit nodes):
//   GET    /api/wireguard/sites              list all exit nodes
//   POST   /api/wireguard/sites              create exit node
//   PATCH  /api/wireguard/sites/:id          update exit node
//   DELETE /api/wireguard/sites/:id          remove exit node
//
// Peers  (client devices):
//   GET    /api/wireguard/peers              list all peers (no private keys)
//   POST   /api/wireguard/peers              create peer (returns private key ONCE)
//   PATCH  /api/wireguard/peers/:id          update name / exit node / note
//   DELETE /api/wireguard/peers/:id          remove peer
//   GET    /api/wireguard/peers/:id/conf     download wg0.conf (contains private key)
//   GET    /api/wireguard/peers/:id/qr       PNG QR code of the client conf (base64)

const router = require('express').Router();
const QRCode = require('qrcode');
const conf = require('@simpleworkjs/conf');
const wgSite = require('../models/wg_site');
const wgPeer = require('../models/wg_peer');
const { renderClientConf } = require('../utils/wg_conf');

// Gateway's own WireGuard public key + endpoint come from conf.wireguard.
// These are set in docker-compose / theta-env and describe this gateway's
// wg0 interface that clients point at.
function gwConf() {
	const wg = conf.wireguard || {};
	return {
		publicKey: wg.serverPublicKey || '',
		endpoint: wg.serverEndpoint || '',
		dns: wg.dns || '',
	};
}

// ── Gateway Info ─────────────────────────────────────────────────────────────

router.get('/gateway-info', async (req, res) => {
	res.json(gwConf());
});

// ── Sites ───────────────────────────────────────────────────────────────────

router.get('/sites', async (req, res, next) => {
	try {
		res.json({ results: await wgSite.list() });
	} catch (e) { next(e); }
});

router.post('/sites', async (req, res, next) => {
	try {
		const { name, endpoint, publicKey, subnet, exitAll, siteId, note } = req.body;
		if (!name || !endpoint || !publicKey) {
			return res.status(400).json({ message: 'name, endpoint, and publicKey are required' });
		}
		const site = await wgSite.create(
			{ name, endpoint, publicKey, subnet, exitAll, siteId, note },
			req.user && req.user.uid
		);
		res.status(201).json(site);
	} catch (e) { next(e); }
});

router.patch('/sites/:id', async (req, res, next) => {
	try {
		const site = await wgSite.update(req.params.id, req.body);
		res.json(site);
	} catch (e) { next(e); }
});

router.delete('/sites/:id', async (req, res, next) => {
	try {
		await wgSite.remove(req.params.id);
		res.json({ ok: true });
	} catch (e) { next(e); }
});

// ── Peers ───────────────────────────────────────────────────────────────────

router.get('/peers', async (req, res, next) => {
	try {
		res.json({ results: await wgPeer.list() });
	} catch (e) { next(e); }
});

router.post('/peers', async (req, res, next) => {
	try {
		const { name, exitSiteId, note } = req.body;
		if (!name) return res.status(400).json({ message: 'name is required' });
		const peer = await wgPeer.create(
			{ name, exitSiteId, note },
			req.user && req.user.uid
		);
		// Return the full peer including privateKey — shown ONCE.
		res.status(201).json(peer);
	} catch (e) { next(e); }
});

router.patch('/peers/:id', async (req, res, next) => {
	try {
		const peer = await wgPeer.update(req.params.id, req.body);
		res.json(wgPeer.toPublic(peer));
	} catch (e) { next(e); }
});

router.delete('/peers/:id', async (req, res, next) => {
	try {
		await wgPeer.remove(req.params.id);
		res.json({ ok: true });
	} catch (e) { next(e); }
});

// ── Config / QR ─────────────────────────────────────────────────────────────

async function buildConf(id) {
	const peer = await wgPeer.get(id); // includes privateKey
	if (!peer) throw Object.assign(new Error('Peer not found'), { status: 404 });
	const site = peer.exitSiteId ? await wgSite.get(peer.exitSiteId) : null;
	const { publicKey, endpoint, dns } = gwConf();
	return renderClientConf({ peer, site, serverPub: publicKey, serverEndpoint: endpoint, dns });
}

router.get('/peers/:id/conf', async (req, res, next) => {
	try {
		const confText = await buildConf(req.params.id);
		const peer = await wgPeer.get(req.params.id);
		const filename = `${(peer.name || peer.id).replace(/[^a-z0-9_-]/gi, '_')}.conf`;
		res.setHeader('Content-Type', 'text/plain; charset=utf-8');
		res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
		res.send(confText);
	} catch (e) { next(e); }
});

router.get('/peers/:id/qr', async (req, res, next) => {
	try {
		const confText = await buildConf(req.params.id);
		const dataUrl = await QRCode.toDataURL(confText, {
			errorCorrectionLevel: 'M',
			width: 400,
			margin: 2,
		});
		res.json({ qr: dataUrl });
	} catch (e) { next(e); }
});

// Gateway's own public key (unauthenticated — needed to display in the UI).
router.get('/gateway-info', (req, res) => {
	res.json({ ...gwConf() });
});

module.exports = router;
