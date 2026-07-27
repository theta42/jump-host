'use strict';

// Minimal user endpoint the client framework needs: GET /api/user/me tells the
// browser who it is and whether it's an admin (drives login state + nav).

const router = require('express').Router();
const { isAdmin } = require('../middleware/auth');
const access = require('../utils/access');

router.get('/me', (req, res) => {
	res.json({
		username: req.user && req.user.username,
		groups: req.groups || [],
		isAdmin: isAdmin(req),
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
		res.json({ results: hosts });
	} catch (err) { next(err); }
});

module.exports = router;
