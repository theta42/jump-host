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

// Register models (order matters: User before AuthToken's relation resolves,
// and before ApiToken so `require('.')`'s Table is already exporting User).
require('./user_redis');      // User (redis-backed local + OIDC JIT)
const { ApiToken } = require('./api_token');
module.exports.ApiToken = ApiToken;

// Shared OIDC client (authorization-code + PKCE): session models (Token,
// AuthToken, OidcState), the Auth service, and the /login /logout /oidc/start
// /oidc/callback router — all created on this app's Table/redis. checkApiToken
// wraps ApiToken.authenticate, same wiring as proxy's models/index.js.
const oidcClient = createOidcClient({ Table, checkApiToken: (raw) => ApiToken.authenticate(raw) });
module.exports.Token = oidcClient.Token;
module.exports.AuthToken = oidcClient.AuthToken;
module.exports.OidcState = oidcClient.OidcState;
module.exports.Auth = oidcClient.Auth;
module.exports.authRouter = oidcClient.router;

require('./audit_event');

// Idempotent anti-lockout local admin (was the IIFE in user_redis.js).
bootstrapLocalAdmin(Table.models.User, { defaultName: 'jumpadmin' });

// Standalone mode: initialize @simpleworkjs/orm for local user/host stores.
// The ORM must be loaded before any code calls user_ldap or access — both of
// which check conf.standalone.enabled at require time and may delegate to the
// ORM-backed wrappers. Model registration is synchronous; table sync is async
// but the first query will implicitly wait (Sequelize.sync is in-flight).
// Export the promise so integration tests can await it before seeding data.
let ormReady = Promise.resolve();
if (conf.standalone && conf.standalone.enabled) {
	const { init } = require('@simpleworkjs/orm');
	const ormConf = conf.orm || { dialect: 'sqlite', storage: './data/standalone.sqlite', logging: false };
	ormReady = init({ conf: { orm: ormConf }, models: [require('./standalone_user'), require('./standalone_host')] });
}
module.exports.ormReady = ormReady;