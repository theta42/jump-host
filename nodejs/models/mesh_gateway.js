'use strict';

// Registry of peer theta-gateway instances this gateway has meshed with —
// raw Redis, same pattern as wg_site.js/audit_event.js. Each registration
// carries what's needed to configure a local WireGuard peer entry for them:
// public key, reachable endpoint, and the mesh IP this gateway assigned them
// (MULTI_SITE_SPEC.md's one-octet-per-site addressing, 172.24.<idx>.0/16 +
// 10.<idx>.0.0/16, idx 1-254).
//
// Redis keys:
//   mesh_gateway:<id>   — hash of gateway fields
//   mesh_gateway_index  — sorted set (score = createdAt, value = id)

const crypto = require('crypto');
const conf = require('@simpleworkjs/conf');
const { getRedis } = require('./index');

const MAX_MESH_INDEX = 254;

const P = () => conf.redis.prefix;
const idxKey = () => `${P()}mesh_gateway_index`;
const gatewayKey = (id) => `${P()}mesh_gateway:${id}`;

function serialize(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		out[k] = String(v == null ? '' : v);
	}
	return out;
}

function deserialize(h) {
	if (!h || !h.id) return null;
	return { ...h, meshIndex: Number(h.meshIndex || 0), createdAt: Number(h.createdAt || 0), lastSeenAt: Number(h.lastSeenAt || 0) };
}

async function list() {
	const redis = await getRedis();
	const ids = await redis.zRange(idxKey(), 0, -1);
	const out = [];
	for (const id of ids) {
		const g = deserialize(await redis.hGetAll(gatewayKey(id)));
		if (g) out.push(g);
	}
	return out;
}

async function findByPublicKey(publicKey) {
	const all = await list();
	return all.find((g) => g.publicKey === publicKey) || null;
}

function nextFreeMeshIndex(existing) {
	const used = new Set(existing.map((g) => g.meshIndex).filter(Boolean));
	for (let i = 1; i <= MAX_MESH_INDEX; i++) {
		if (!used.has(i)) return i;
	}
	throw new Error(`Mesh index space exhausted (max ${MAX_MESH_INDEX} gateways)`);
}

// Register (or re-register, idempotent by publicKey) a peer gateway.
// Re-registering the same public key updates its endpoint/siteSlug but
// reuses its existing mesh index -- a gateway that re-registers after a
// restart must not get bumped to a new mesh subnet.
//
// meshIndex is normally auto-assigned (the next free local index) -- correct
// when THIS gateway is the one handing out indices (POST /register, for both
// the caller and itself via ensureOwnMeshIndex). But the INITIATING side of
// a join (POST /join) doesn't get to pick its own index -- the remote
// already assigned it and returned it in the response -- so an explicit
// meshIndex is accepted to record that exact value instead of whatever this
// gateway's own local registry would have auto-picked (which has no reason
// to agree with the value actually configured on the live wg0 interface).
async function register({ publicKey, endpoint, siteSlug, meshIndex: explicitMeshIndex }) {
	const redis = await getRedis();
	const existing = await list();
	const already = existing.find((g) => g.publicKey === publicKey);

	const now = Date.now();
	if (already) {
		const updated = { ...already, endpoint, siteSlug: siteSlug || already.siteSlug, lastSeenAt: now };
		await redis.hSet(gatewayKey(already.id), serialize(updated));
		return updated;
	}

	const id = crypto.randomBytes(8).toString('hex');
	const meshIndex = explicitMeshIndex || nextFreeMeshIndex(existing);
	const gateway = { id, publicKey, endpoint, siteSlug: siteSlug || '', meshIndex, createdAt: now, lastSeenAt: now };
	await redis.hSet(gatewayKey(id), serialize(gateway));
	await redis.zAdd(idxKey(), { score: now, value: id });
	return gateway;
}

async function remove(id) {
	const redis = await getRedis();
	const gw = deserialize(await redis.hGetAll(gatewayKey(id)));
	if (!gw) return null;
	await redis.del(gatewayKey(id));
	await redis.zRem(idxKey(), id);
	return gw;
}

module.exports = { list, findByPublicKey, register, remove, MAX_MESH_INDEX };
