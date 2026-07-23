'use strict';

// Web UI/API auth: a signed-in admin session (cookie) whose LDAP groups
// intersect conf.auth.adminGroups. /health and the login routes are exempt
// (mounted before this middleware).

const conf = require('@simpleworkjs/conf');
const Session = require('../models/session');

function parseCookies(header) {
	const out = {};
	(header || '').split(';').forEach((p) => {
		const i = p.indexOf('=');
		if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
	});
	return out;
}

async function requireAdmin(req, res, next) {
	const token = parseCookies(req.headers.cookie).jump_session;
	const session = await Session.verify(token);
	if (!session) {
		if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
		return res.redirect('/login');
	}
	const groups = JSON.parse(session.groups || '[]');
	const admin = (conf.auth.adminGroups || []).some((g) => groups.includes(g));
	if (!admin) {
		if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'forbidden' });
		return res.status(403).render('login', { error: 'Your account is not a jump-host admin.', name: conf.name });
	}
	req.jumpUser = { uid: session.uid, groups };
	next();
}

module.exports = { requireAdmin, parseCookies };
