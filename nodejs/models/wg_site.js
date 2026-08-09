'use strict';

// WireGuard exit-node / site model — raw Redis (same pattern as audit_event.js).
//
// Each "site" is a location clients can route through. Admins add/remove sites
// dynamically via the Theta Gateway UI.
//
// Redis keys:
//   wg_site:<id>   — hash of site fields
//   wg_site_index  — sorted set  (score = createdAt, value = id)

const crypto = require('crypto');
const conf = require('@simpleworkjs/conf');
const { getRedis } = require('./index');

const P = () => conf.redis.prefix;
const idxKey = () => `${P()}wg_site_index`;
const siteKey = (id) => `${P()}wg_site:${id}`;

function serialize(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		out[k] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v == null ? '' : v);
	}
	return out;
}

function deserialize(h) {
	if (!h || !h.id) return null;
	return {
		...h,
		createdAt: Number(h.createdAt || 0),
		exitAll: h.exitAll === '1',
	};
}

async function create(data, createdBy) {
	const id = crypto.randomBytes(8).toString('hex');
	const site = {
		id,
		name: data.name || 'Unnamed Site',
		endpoint: data.endpoint || '',
		publicKey: data.publicKey || '',
		subnet: data.subnet || '0.0.0.0/0',
		exitAll: !!data.exitAll,
		siteId: data.siteId || '',
		note: data.note || '',
		createdBy: createdBy || '',
		createdAt: Date.now(),
	};
	const redis = await getRedis();
	await redis.hSet(siteKey(id), serialize(site));
	await redis.zAdd(idxKey(), { score: site.createdAt, value: id });
	return site;
}

async function get(id) {
	const redis = await getRedis();
	return deserialize(await redis.hGetAll(siteKey(id)));
}

async function update(id, patch) {
	const redis = await getRedis();
	const existing = await get(id);
	if (!existing) throw Object.assign(new Error('Site not found'), { status: 404 });
	const merged = { ...existing, ...patch, id }; // id is immutable
	await redis.hSet(siteKey(id), serialize(merged));
	return merged;
}

async function remove(id) {
	const redis = await getRedis();
	await redis.del(siteKey(id));
	await redis.zRem(idxKey(), id);
}

async function list() {
	const redis = await getRedis();
	const ids = await redis.zRange(idxKey(), 0, -1);
	const sites = await Promise.all(ids.map(get));
	return sites.filter(Boolean);
}

module.exports = { create, get, update, remove, list };
