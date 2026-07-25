'use strict';

// model-redis backing (same store the sibling apps use). Table is the base
// class; getRedis() exposes the underlying node-redis client for the counters
// and sorted-set index in models/metrics.js and models/audit_event.js.

const conf = require('@simpleworkjs/conf');
const { setUpTable } = require('model-redis');
const { createOidcClient, bootstrapLocalAdmin } = require('@simpleworkjs/oidc-client');

const Table = setUpTable(conf.redis);

module.exports = Table;

// The raw node-redis client (created + connecting inside model-redis) — used
// for the INCR counters and the sorted-set audit index. model-redis connects
// it asynchronously; ensure it's open before first use.
let readyPromise;
async function getRedis() {
	const client = Table.redisClient;
	if (!readyPromise) {
		readyPromise = (async () => {
			if (!client.isOpen) {
				try { await client.connect(); } catch (_) { /* already connecting */ }
			}
			return client;
		})();
	}
	await readyPromise;
	return client;
}

module.exports.getRedis = getRedis;

// Register models (order matters: User before AuthToken's relation resolves).
require('./user_redis');      // User (redis-backed local + OIDC JIT)

// Shared OIDC client (authorization-code + PKCE): session models (Token,
// AuthToken, OidcState), the Auth service, and the /login /logout /oidc/start
// /oidc/callback router — all created on this app's Table/redis. jump-host has
// no Bearer PATs, so checkApiToken is omitted (Auth.checkApiToken is absent).
const oidcClient = createOidcClient({ Table });
module.exports.Token = oidcClient.Token;
module.exports.AuthToken = oidcClient.AuthToken;
module.exports.OidcState = oidcClient.OidcState;
module.exports.Auth = oidcClient.Auth;
module.exports.authRouter = oidcClient.router;

require('./audit_event');

// Idempotent anti-lockout local admin (was the IIFE in user_redis.js).
bootstrapLocalAdmin(Table.models.User, { defaultName: 'jumpadmin' });