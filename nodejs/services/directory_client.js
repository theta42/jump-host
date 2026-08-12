'use strict';

// How this gateway learns what to configure.
//
// The directory is the registry and the propagation bus: it allocates the one
// cluster-unique number (siteId, which IS the site's LDAP ServerID) and
// distributes what every gateway has published about itself. This gateway
// PULLS that, applies it, and publishes its own facts back. It never writes
// another site's row -- PUT /api/mesh/self has no site parameter, the
// directory decides which row is ours from which node we authenticate as.
//
// Everything is cached in Redis after a successful fetch, and the cache is
// what reconcile falls back to when the directory is unreachable. A gateway
// must keep routing through a directory outage: these are small deployments
// where the directory and the gateway may well be the same box being rebooted,
// and tunnels dropping because a web app is restarting would be absurd.

const conf = require('@simpleworkjs/conf');
const { getRedis } = require('../models/index');

const FETCH_TIMEOUT_MS = 10000;

const cacheKey = (name) => `${conf.redis.prefix}mesh_cache:${name}`;

function directoryUrl() {
	// The same setting the rest of the gateway already uses to reach the
	// directory; no second place to configure it.
	return (process.env.DIRECTORY_INTERNAL_URL || process.env.SSO_INTERNAL_URL || conf.sso && conf.sso.url || '').replace(/\/+$/, '');
}

function directoryToken() {
	return process.env.DIRECTORY_API_TOKEN || (conf.sso && conf.sso.apiToken) || '';
}

async function request(method, path, body) {
	const base = directoryUrl();
	if (!base) throw new Error('no directory URL configured (DIRECTORY_INTERNAL_URL)');
	const token = directoryToken();
	if (!token) throw new Error('no directory API token configured (DIRECTORY_API_TOKEN)');

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const resp = await fetch(base + path, {
			method,
			headers: {
				Authorization: 'Bearer ' + token,
				...(body ? { 'Content-Type': 'application/json' } : {})
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: controller.signal
		});
		if (!resp.ok) {
			const text = (await resp.text().catch(() => '')).slice(0, 300);
			throw new Error(`${method} ${path} -> HTTP ${resp.status} ${text}`);
		}
		return await resp.json();
	} finally {
		clearTimeout(timer);
	}
}

async function cacheWrite(name, value) {
	try {
		const redis = await getRedis();
		await redis.set(cacheKey(name), JSON.stringify({ at: Date.now(), value }));
	} catch (err) {
		// A cache write failure must never fail the fetch that produced it.
		console.warn(`[directory] could not cache ${name}: ${err.message}`);
	}
}

async function cacheRead(name) {
	try {
		const redis = await getRedis();
		const raw = await redis.get(cacheKey(name));
		if (!raw) return null;
		return JSON.parse(raw);
	} catch (err) {
		console.warn(`[directory] could not read cached ${name}: ${err.message}`);
		return null;
	}
}

/**
 * Fetch, cache, and return. On failure fall back to the cache and say so, so a
 * caller can log "using cached config" rather than silently applying stale
 * state as though it were fresh.
 *
 * @returns {{value: object, stale: boolean, cachedAt: number|null, error: string|null}}
 */
async function fetchWithCache(name, path) {
	try {
		const value = await request('GET', path);
		await cacheWrite(name, value);
		return { value, stale: false, cachedAt: Date.now(), error: null };
	} catch (err) {
		const cached = await cacheRead(name);
		if (!cached) return { value: null, stale: true, cachedAt: null, error: err.message };
		console.warn(`[directory] ${path} failed (${err.message}); using config cached ${Math.round((Date.now() - cached.at) / 1000)}s ago`);
		return { value: cached.value, stale: true, cachedAt: cached.at, error: err.message };
	}
}

/** Peers to build, with AllowedIPs already resolved by the directory. */
const fetchPeers = () => fetchWithCache('peers', '/api/mesh/peers');

/** Client devices this site is responsible for, and each one's exit. */
const fetchSiteClients = () => fetchWithCache('site_clients', '/api/mesh/site-clients');

/** The whole roster -- needed for exit endpoints and UI display. */
const fetchRoster = () => fetchWithCache('roster', '/api/mesh/roster');

/**
 * Publish this gateway's own facts. Best-effort: failing to publish must not
 * stop the gateway configuring itself from what it already knows.
 */
async function publishSelf(facts) {
	return request('PUT', '/api/mesh/self', facts);
}

module.exports = {
	fetchPeers, fetchSiteClients, fetchRoster, publishSelf,
	directoryUrl, directoryToken, _request: request, _cacheRead: cacheRead
};
