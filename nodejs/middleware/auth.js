'use strict';

// Web UI/API auth, mirroring the sibling apps: a browser session token
// (`auth-token: <AuthToken uuid>`) established via local login or the OIDC
// callback. The token carries the group snapshot captured at login.

const conf = require('@simpleworkjs/conf');
const { Auth } = require('../models/auth');

async function auth(req, res, next){
	try{
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

module.exports = { auth, requireAdmin, authIO, isAdmin };
