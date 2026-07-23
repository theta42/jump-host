'use strict';

// model-redis backing (same store the other stack apps use). Table is the
// base class; getRedis() exposes the underlying node-redis client for the
// counters and sorted-set index in models/metrics.js and models/audit_event.js.

const conf = require('@simpleworkjs/conf');
const { setUpTable } = require('model-redis');

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

require('./session');
require('./audit_event');
