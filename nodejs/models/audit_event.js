'use strict';

// Audit trail of every connection attempt/session. Stored as one redis hash
// per event plus a sorted-set index (score = timestamp) for paged reads,
// trimmed to conf.audit.maxEvents. Raw redis (not the Table model) because we
// want the zset index and cheap range reads.

const crypto = require('crypto');
const conf = require('@simpleworkjs/conf');
const { getRedis } = require('./index');

const P = () => conf.redis.prefix;
const idxKey = () => `${P()}audit_index`;
const evtKey = (id) => `${P()}audit_${id}`;

// A live event: create() returns a handle you finish() when the session ends.
async function create(fields) {
	const id = crypto.randomUUID();
	const ts = Date.now();
	const event = {
		id, ts,
		uid: '', authMethod: '', mode: '',
		targetSlug: '', targetAddr: '', targetPort: '',
		channel: '', clientIp: '',
		success: false, failReason: '',
		hostKeyFp: '', startedAt: ts, endedAt: '', durationMs: '',
		bytesIn: 0, bytesOut: 0,
		...fields,
	};
	await write(event);
	return {
		id,
		event,
		async patch(update) {
			Object.assign(event, update);
			await write(event);
		},
		async finish(update = {}) {
			Object.assign(event, update, {
				endedAt: Date.now(),
				durationMs: Date.now() - event.startedAt,
			});
			await write(event);
		},
	};
}

async function write(event) {
	const redis = await getRedis();
	await redis.hSet(evtKey(event.id), serialize(event));
	await redis.zAdd(idxKey(), { score: event.ts, value: event.id });
	// Trim oldest beyond the cap.
	const max = (conf.audit && conf.audit.maxEvents) || 50000;
	const count = await redis.zCard(idxKey());
	if (count > max) {
		const stale = await redis.zRange(idxKey(), 0, count - max - 1);
		if (stale.length) {
			await redis.zRem(idxKey(), stale);
			await redis.del(stale.map(evtKey));
		}
	}
}

function serialize(event) {
	const out = {};
	for (const [k, v] of Object.entries(event)) {
		out[k] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v == null ? '' : v);
	}
	return out;
}

function deserialize(h) {
	if (!h || !h.id) return null;
	return {
		...h,
		ts: Number(h.ts),
		success: h.success === '1',
		bytesIn: Number(h.bytesIn || 0),
		bytesOut: Number(h.bytesOut || 0),
		durationMs: h.durationMs === '' ? null : Number(h.durationMs),
	};
}

// Newest-first paged read with optional filters.
async function list({ page = 0, pageSize = 50, uid, target, status } = {}) {
	const redis = await getRedis();
	const ids = await redis.zRange(idxKey(), 0, -1, { REV: true });
	const events = [];
	for (const id of ids) {
		const e = deserialize(await redis.hGetAll(evtKey(id)));
		if (!e) continue;
		if (uid && e.uid !== uid) continue;
		if (target && e.targetSlug !== target && e.targetAddr !== target) continue;
		if (status === 'success' && !e.success) continue;
		if (status === 'fail' && e.success) continue;
		events.push(e);
	}
	const start = page * pageSize;
	return { total: events.length, page, pageSize, results: events.slice(start, start + pageSize) };
}

module.exports = { create, list };
