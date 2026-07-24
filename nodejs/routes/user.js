'use strict';

// Minimal user endpoint the client framework needs: GET /api/user/me tells the
// browser who it is and whether it's an admin (drives login state + nav).

const router = require('express').Router();
const { isAdmin } = require('../middleware/auth');

router.get('/me', (req, res) => {
	res.json({
		username: req.user && req.user.username,
		groups: req.groups || [],
		isAdmin: isAdmin(req),
	});
});

module.exports = router;
