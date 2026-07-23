'use strict';

// Web login: LDAP bind as the user, require an adminGroups membership, mint a
// session cookie. (OIDC against the SSO is a follow-up.)

const express = require('express');
const conf = require('@simpleworkjs/conf');
const userLdap = require('../models/user_ldap');
const Session = require('../models/session');

const router = express.Router();

router.get('/login', (req, res) => {
	res.render('login', { error: null, name: conf.name });
});

router.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
	const { uid, password } = req.body || {};
	const fail = (msg) => res.status(401).render('login', { error: msg, name: conf.name });
	try {
		const user = await userLdap.getUser(uid);
		if (!user) return fail('Invalid credentials.');
		const ok = await userLdap.checkPassword(user.dn, password);
		if (!ok) return fail('Invalid credentials.');
		const groups = await userLdap.getGroups(user.dn);
		const admin = (conf.auth.adminGroups || []).some((g) => groups.includes(g));
		if (!admin) return fail('Your account is not a jump-host admin.');

		const session = await Session.start(user.uid, groups, conf.auth.sessionTTLms);
		res.setHeader('Set-Cookie', `jump_session=${session.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(conf.auth.sessionTTLms / 1000)}`);
		res.redirect('/');
	} catch (err) {
		return fail('Login failed.');
	}
});

router.post('/logout', (req, res) => {
	res.setHeader('Set-Cookie', 'jump_session=; HttpOnly; Path=/; Max-Age=0');
	res.redirect('/login');
});

module.exports = router;
