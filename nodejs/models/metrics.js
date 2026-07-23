'use strict';

// Cheap counters for the dashboard. redis INCR — no history, just totals.

const conf = require('@simpleworkjs/conf');
const { getRedis } = require('./index');

const P = () => `${conf.redis.prefix}m_`;

async function bump({ uid, hostSlug, success }) {
	const redis = await getRedis();
	const day = new Date().toISOString().slice(0, 10);
	const ops = [redis.incr(`${P()}total`), redis.incr(`${P()}day_${day}`)];
	if (!success) ops.push(redis.incr(`${P()}fail`));
	if (uid) ops.push(redis.incr(`${P()}user_${uid}`));
	if (hostSlug) ops.push(redis.incr(`${P()}host_${hostSlug}`));
	await Promise.all(ops);
}

async function summary() {
	const redis = await getRedis();
	const [total, fail] = await Promise.all([
		redis.get(`${P()}total`),
		redis.get(`${P()}fail`),
	]);
	const userKeys = await redis.keys(`${P()}user_*`);
	const hostKeys = await redis.keys(`${P()}host_*`);
	const topN = async (keys, strip) => {
		const entries = await Promise.all(keys.map(async (k) => [k.slice(strip.length), Number(await redis.get(k))]));
		return entries.sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
	};
	return {
		total: Number(total || 0),
		fail: Number(fail || 0),
		topUsers: await topN(userKeys, `${P()}user_`),
		topHosts: await topN(hostKeys, `${P()}host_`),
	};
}

module.exports = { bump, summary };
