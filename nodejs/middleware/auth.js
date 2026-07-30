'use strict';

// Web UI/API auth, mirroring the sibling apps: a browser session token
// (`auth-token: <AuthToken uuid>`) established via local login or the OIDC
// callback. The token carries the group snapshot captured at login.

const conf = require('@simpleworkjs/conf');
const { Auth } = require('../models');

async function auth(req, res, next){
	try{
		// API-only token: `Authorization: Bearer jmp_<id>_<secret>`. Carries no
		// group claims (see models/api_token.js), so it authenticates as its
		// creator but never passes requireAdmin below.
		const authz = req.header('authorization') || '';
		if(authz.slice(0, 7).toLowerCase() === 'bearer '){
			const t = await Auth.checkApiToken(authz.slice(7));
			req.token = {
				user: {username: t.created_by},
				created_by: t.created_by,
				groupsArray: () => [],
				check: () => true,
				is_valid: true,
			};
			req.user = req.token.user;
			req.groups = [];
			return next();
		}

		req.token = await Auth.checkToken(req.header('auth-token'));
		req.user = req.token.user;
		req.groups = typeof req.token.groupsArray === 'function' ? req.token.groupsArray() : [];
		return next();
	}catch(error){
		next(error);
	}
}

// Is the authenticated request an admin? Admin = a session whose OIDC groups
// intersect conf.auth.adminGroups, OR the local anti-lockout admin
// (conf.auth.adminUsers). The whole web UI is admin-only (audit + metrics).
function isAdmin(req){
	const adminGroups = (conf.auth && conf.auth.adminGroups) || [];
	const adminUsers = (conf.auth && conf.auth.adminUsers) || [];
	const username = req.user && req.user.username;
	if(username && adminUsers.includes(username)) return true;
	return (req.groups || []).some(g => adminGroups.includes(g));
}

async function requireAdmin(req, res, next){
	if(isAdmin(req)) return next();
	const error = new Error('Forbidden');
	error.name = 'Forbidden';
	error.status = 403;
	error.message = 'Admin access required.';
	next(error);
}

// Jump admin = access to the audit page/data. A narrower grant than full
// jump-host admin: full admins (isAdmin) always qualify, plus anyone in
// conf.auth.jumpAdminGroups (e.g. a dedicated app_jump_admin LDAP group) can
// be granted audit access without also getting other admin-only rights.
function isJumpAdmin(req){
	if(isAdmin(req)) return true;
	const jumpAdminGroups = (conf.auth && conf.auth.jumpAdminGroups) || [];
	return (req.groups || []).some(g => jumpAdminGroups.includes(g));
}

async function requireJumpAdmin(req, res, next){
	if(isJumpAdmin(req)) return next();
	const error = new Error('Forbidden');
	error.name = 'Forbidden';
	error.status = 403;
	error.message = 'Jump admin access required.';
	next(error);
}

// Socket.IO handshake auth (app-base.js connects with the session token).
async function authIO(socket, next){
	try{
		const tok = socket.handshake.auth && socket.handshake.auth.token;
		if(!tok) return next(Auth.errors.login());
		const token = await Auth.checkToken(tok);
		socket.user = token.user;
		next();
	}catch(error){
		next(error);
	}
}

module.exports = { auth, requireAdmin, authIO, isAdmin, isJumpAdmin, requireJumpAdmin };
