'use strict';

const Table = require('.');
const {withEvents} = require('../utils/model_events');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// Self-service personal access token (PAT) for the jump host's own API.
// Format:  jmp_<id>_<secret>
//   id     — 24-char hex, stored plaintext as the record key (O(1) lookup)
//   secret — 48-char hex, stored only as a bcrypt hash (isPrivate); shown ONCE
//
// Authenticated via `Authorization: Bearer jmp_...`. Mirrors proxy's
// models/api_token.js — see that file for the fuller design notes. jump-host
// has no per-user group snapshot the way proxy/sso do (its authz is a single
// admin/non-admin bit off conf.auth.adminGroups/adminUsers), so a token
// authenticates as its creator only; the auth middleware re-derives
// admin-ness from that user's current groups, same as a live session.
//
// No `static _ttl`: records persist (lifetime is the optional expires_at field).

const PREFIX = 'jmp_';
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

class ApiToken extends Table{
	static _key = 'id';
	static _keyMap = {
		'id':           {default: function(){ return randomHex(12) }, type: 'string'},
		'secret_hash':  {isRequired: true, type: 'string', isPrivate: true},
		'name':         {isRequired: true, type: 'string', min: 1, max: 255},
		'description':  {default: '', type: 'string'},
		'created_by':   {isRequired: true, type: 'string', min: 3, max: 500},
		'created_on':   {default: function(){return (new Date).getTime()}},
		'updated_on':   {default: function(){return (new Date).getTime()}, always: true},
		'expires_at':   {default: 0, type: 'number'}, // epoch ms; 0 = never
		'last_used_on': {default: 0, type: 'number'},
		'is_valid':     {default: true, type: 'boolean'},
	}

	get isExpired() {
		return this.expires_at > 0 && (new Date).getTime() > this.expires_at;
	}

	static async add(data){
		const id = randomHex(12);
		const secret = randomHex(24);
		data.id = id;
		data.secret_hash = await bcrypt.hash(secret, 10);
		const token = await this.create(data);
		token._raw_token = `${PREFIX}${id}_${secret}`;
		return token;
	}

	async rotate(){
		const secret = randomHex(24);
		await this.update({ secret_hash: await bcrypt.hash(secret, 10) });
		return `${PREFIX}${this.id}_${secret}`;
	}

	// Validate a raw `jmp_<id>_<secret>` string. Throws a generic Error on any
	// failure so the caller (Auth.checkApiToken) can collapse every case into
	// one 401 (no existence / wrong-secret / expired leak).
	static async authenticate(raw){
		const m = /^jmp_([0-9a-f]{24})_([0-9a-f]{48})$/i.exec(String(raw || ''));
		if(!m) throw new Error('InvalidApiToken');
		let token;
		try{
			token = await this.get(m[1]);
		}catch(e){
			throw new Error('InvalidApiToken');
		}
		if(!token) throw new Error('InvalidApiToken');
		const ok = await bcrypt.compare(m[2], token.secret_hash);
		if(!ok || !token.is_valid || token.isExpired) throw new Error('InvalidApiToken');
		// Best-effort: stamp last use. Fire-and-forget so a Redis hiccup never
		// fails an otherwise-valid request.
		try{ await token.update({ last_used_on: (new Date).getTime() }); }catch(_){}
		return token;
	}
}

// Announce create/remove so a token issued or revoked in one tab updates the
// list in another. Not update: the best-effort last_used_on write happens on
// every authenticated API call, and announcing that would put an event on the
// socket per request. secret_hash is isPrivate, so model-redis strips it in
// toJSON and it never reaches the bus.
withEvents(ApiToken, 'ApiToken', {actions: ['create', 'remove']});
ApiToken.register();

module.exports = {ApiToken};
