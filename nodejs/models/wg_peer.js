'use strict';

// WireGuard peer model — raw Redis (same pattern as audit_event.js).
//
// Each peer is a client device (phone, laptop, etc.) with a unique keypair and
// an assigned IP on the gateway's wg0 interface.
//
// Redis keys:
//   wg_peer:<id>   — hash of peer fields
//   wg_peer_index  — sorted set  (score = createdAt, value = id)
//   wg_peer_ip_seq — integer counter for next assignable IP
//
// Assigned IPs are allocated from the gateway's wg pool (default 10.0.0.0/8
// range starting at .2 — .1 is the gateway itself). Override via conf.wireguard.
//
// Fields:
//   id          - 16-char hex
//   name        - human label, e.g. "william-phone"
//   publicKey   - WireGuard public key (X25519 base64)
//   privateKey  - WireGuard private key — PRIVATE, not returned by toPublic()
//   assignedIP  - e.g. "10.0.0.2"
//   exitSiteId  - ID of the wg_site to route through ('' = full tunnel via gw)
//   createdBy   - uid of admin/user who created it
//   createdAt   - unix ms
//   note        - free-text

const crypto = require('crypto');
const conf = require('@simpleworkjs/conf');
const { getRedis } = require('./index');
const { generateKeypair } = require('../utils/wg_keys');

const P = () => conf.redis.prefix;
const idxKey = () => `${P()}wg_peer_index`;
const peerKey = (id) => `${P()}wg_peer:${id}`;
const ipSeqKey = () => `${P()}wg_peer_ip_seq`;

// Start IP allocation at x.x.x.2 (x.x.x.1 is the gateway interface).
const WG_POOL_BASE = (conf.wireguard && conf.wireguard.poolBase) || '10.100.0';

function seqToIP(seq) {
	// Allocate within /16 pool: 10.100.0.2 – 10.100.255.254
	const octet3 = Math.floor((seq - 2) / 254);
	const octet4 = ((seq - 2) % 254) + 1;
	return `${WG_POOL_BASE.split('.').slice(0, 2).join('.')}.${octet3}.${octet4 + 1}`;
}

function serialize(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		out[k] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v == null ? '' : v);
	}
	return out;
}

function deserialize(h) {
	if (!h || !h.id) return null;
	return { ...h, createdAt: Number(h.createdAt || 0) };
}

/** Strip the private key before sending to the client. */
function toPublic(peer) {
	if (!peer) return null;
	const { privateKey: _priv, ...pub } = peer; // eslint-disable-line no-unused-vars
	return pub;
}

async function create(data, createdBy) {
	const redis = await getRedis();
	const id = crypto.randomBytes(8).toString('hex');
	const seq = await redis.incr(ipSeqKey());
	const { privateKey, publicKey } = generateKeypair();
	const peer = {
		id,
		name: data.name || 'unnamed',
		publicKey,
		privateKey, // stored server-side; sent once on create / conf download
		assignedIP: seqToIP(seq),
		exitSiteId: data.exitSiteId || '',
		createdBy: createdBy || '',
		createdAt: Date.now(),
		note: data.note || '',
	};
	await redis.hSet(peerKey(id), serialize(peer));
	await redis.zAdd(idxKey(), { score: peer.createdAt, value: id });
	return peer; // includes privateKey — caller decides what to expose
}

async function get(id) {
	const redis = await getRedis();
	return deserialize(await redis.hGetAll(peerKey(id)));
}

async function update(id, patch) {
	const redis = await getRedis();
	const existing = await get(id);
	if (!existing) throw Object.assign(new Error('Peer not found'), { status: 404 });
	// Only allow mutable fields to be patched
	const allowed = ['name', 'exitSiteId', 'note'];
	const safe = {};
	for (const k of allowed) if (k in patch) safe[k] = patch[k];
	const merged = { ...existing, ...safe };
	await redis.hSet(peerKey(id), serialize(merged));
	return merged;
}

async function remove(id) {
	const redis = await getRedis();
	await redis.del(peerKey(id));
	await redis.zRem(idxKey(), id);
}

async function list() {
	const redis = await getRedis();
	const ids = await redis.zRange(idxKey(), 0, -1, { REV: true });
	const peers = await Promise.all(ids.map(get));
	return peers.filter(Boolean).map(toPublic);
}

module.exports = { create, get, update, remove, list, toPublic };
