'use strict';

const conf = require('@simpleworkjs/conf');
const { getRedis } = require('../models');
const { generateKeypair } = require('../utils/wg_keys');
const wgSite = require('../models/wg_site');

async function bootstrapWireguard() {
	try {
		const redis = await getRedis();
		const P = conf.redis.prefix || '';
		const keypairKey = `${P}wg_gateway_keypair`;

		// 1. Ensure Gateway WireGuard Keypair
		let keypairData = await redis.hGetAll(keypairKey);
		if (!keypairData || !keypairData.publicKey) {
			const kp = generateKeypair();
			keypairData = {
				privateKey: kp.privateKey,
				publicKey: kp.publicKey,
				createdAt: String(Date.now()),
			};
			await redis.hSet(keypairKey, keypairData);
			console.log('[bootstrap] Generated fresh WireGuard Gateway keypair.');
		}

		if (!conf.wireguard) conf.wireguard = {};
		conf.wireguard.serverPublicKey = keypairData.publicKey;
		conf.wireguard.serverPrivateKey = keypairData.privateKey;

		if (!conf.wireguard.serverEndpoint) {
			const domain = conf.domain || 'suite.vm42.us';
			conf.wireguard.serverEndpoint = `${domain}:51820`;
		}

		// 2. Ensure Default Site Exit Node ("This Site")
		const existingSites = await wgSite.list().catch(() => []);
		if (!existingSites || existingSites.length === 0) {
			const siteName = conf.siteName || process.env.CFG_SITE_NAME || '718it';
			const defaultSite = await wgSite.create({
				name: `${siteName} (This Site)`,
				endpoint: conf.wireguard.serverEndpoint,
				publicKey: keypairData.publicKey,
				subnet: '0.0.0.0/0',
				exitAll: true,
				siteId: siteName,
				note: 'Default local site exit node initialized during bootstrap',
			}, 'bootstrap');
			console.log(`[bootstrap] Initialized default WireGuard exit node '${defaultSite.name}' (${defaultSite.id}).`);
		}
	} catch (err) {
		console.error('[bootstrap] WireGuard bootstrap error:', err.message);
	}
}

module.exports = { bootstrapWireguard };
