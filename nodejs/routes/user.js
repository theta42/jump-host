'use strict';

// Minimal user endpoint the client framework needs: GET /api/user/me tells the
// browser who it is and whether it's an admin (drives login state + nav).

const router = require('express').Router();
const { isAdmin, isJumpAdmin } = require('../middleware/auth');
const access = require('../utils/access');
const metrics = require('../models/metrics');
const registry = require('../services/session_registry');

router.get('/me', (req, res) => {
	res.json({
		username: req.user && req.user.username,
		groups: req.groups || [],
		isAdmin: isAdmin(req),
		isJumpAdmin: isJumpAdmin(req),
	});
});

// The hosts this session can SSH to — every host for an admin, otherwise the
// same group-based resolution the SSH front door uses (accessibleHosts),
// fed the OIDC session's already-known groups instead of an LDAP lookup.
router.get('/hosts', async (req, res, next) => {
	try {
		const hosts = isAdmin(req)
			? await access.allHosts()
			: await access.accessibleHosts({ uid: req.user && req.user.username, groups: req.groups || [] });

		// Enrich with connection state for the dashboard's host list: whether a
		// session is live right now (active bridges, session_registry), plus the
		// last successful/failed connection times (models/metrics).
		const connectedSlugs = new Set(registry.list().map((s) => s.slug));
		const last = await metrics.lastForHosts(hosts.map((h) => h.slug));
		const enriched = hosts.map((h) => ({
			...h,
			connected: connectedSlugs.has(h.slug),
			lastConnected: (last[h.slug] && last[h.slug].lastConnected) || null,
			lastFailed: (last[h.slug] && last[h.slug].lastFailed) || null,
		}));

		res.json({ results: enriched });
	} catch (err) { next(err); }
});

module.exports = router;
