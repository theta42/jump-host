'use strict';

// Web UI sessions — a signed-in admin's browser token. model-redis Table with
// a TTL so entries expire and survive restarts.

const crypto = require('crypto');
const Table = require('.');

class Session extends Table {
	static _key = 'token';
	static _keyMap = {
		'token':      {default: function(){ return crypto.randomUUID() }, type: 'string'},
		'uid':        {isRequired: true, type: 'string'},
		'groups':     {default: '[]', type: 'string'},
		'created_on': {default: function(){ return (new Date).getTime() }},
		'expires_at': {default: 0, type: 'number'},
	}
}

Session.register();

Session.start = async function (uid, groups, ttlMs) {
	return Session.create({
		uid,
		groups: JSON.stringify(groups || []),
		expires_at: Date.now() + ttlMs,
	}, { ttl: Math.ceil(ttlMs / 1000) });
};

Session.verify = async function (token) {
	if (!token) return null;
	let session;
	try {
		session = await Session.get(token);
	} catch (_) {
		return null;
	}
	if (!session || session.expires_at < Date.now()) return null;
	return session;
};

module.exports = Session;
