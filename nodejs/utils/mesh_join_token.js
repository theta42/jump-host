'use strict';

// Single-use, short-lived tokens that let a new theta-gateway register into
// this one's WireGuard mesh (POST /api/mesh/register). Same shape as
// theta-directory's site join keys: minted by an admin, shown once, GETDEL
// (Redis) on use so a token can register exactly one gateway, ever.

const crypto = require('crypto');
const conf = require('@simpleworkjs/conf');
const { getRedis } = require('../models/index');

const TTL_SECONDS = 15 * 60;

const key = (token) => `${conf.redis.prefix}mesh_join_token:${token}`;

async function mint() {
	const token = 'mjt_' + crypto.randomBytes(24).toString('base64url');
	const redis = await getRedis();
	await redis.set(key(token), '1', { EX: TTL_SECONDS });
	return { token, expiresInSeconds: TTL_SECONDS };
}

async function consume(token) {
	if (!token) return false;
	const redis = await getRedis();
	return (await redis.getDel(key(token))) === '1';
}

module.exports = { mint, consume };
