'use strict';

// Mesh addressing. This file MUST agree with theta-directory's
// utils/mesh_addressing.js exactly -- the directory decides what a site's
// addresses are, this gateway configures them, and a disagreement produces
// tunnels that handshake and carry nothing. Both sides pin the numbers in
// tests that name the other.
//
//   172.24.0.<siteId>/32     this gateway's mesh identity
//   10.<siteId>.0.0/16       everything at this site
//
// Inside a site's /16:
//
//   10.<s>.0.1               this gateway, acting as the site router
//   10.<s>.0.0/24            site services (directory .2, proxy .3, ...)
//   10.<s>.168.0/24          NETMAP shadow of a physical LAN
//   10.<s>.172.0/24          NETMAP shadow of a second physical LAN
//   10.<s>.128.0/17          client devices
//
// siteId is the site's ldapServerId, allocated once by the directory master
// when the site joined. This gateway never picks one: it asks.

const MAX_SITE_ID = 254;
const MIN_SITE_ID = 1;
const MESH_PREFIX = '172.24.0';
const SHADOW_SLOTS = [168, 172];

function assertSiteId(siteId) {
	const id = Number(siteId);
	if (!Number.isInteger(id) || id < MIN_SITE_ID || id > MAX_SITE_ID) {
		throw new Error(`site id must be an integer in [${MIN_SITE_ID}, ${MAX_SITE_ID}], got ${siteId}`);
	}
	return id;
}

const meshAddress = (siteId) => `${MESH_PREFIX}.${assertSiteId(siteId)}/32`;
const meshIp = (siteId) => `${MESH_PREFIX}.${assertSiteId(siteId)}`;
const siteCidr = (siteId) => `10.${assertSiteId(siteId)}.0.0/16`;
const siteGatewayIp = (siteId) => `10.${assertSiteId(siteId)}.0.1`;
const siteGatewayCidr = (siteId) => `10.${assertSiteId(siteId)}.0.1/16`;
const clientPoolCidr = (siteId) => `10.${assertSiteId(siteId)}.128.0/17`;

function shadowCidr(siteId, slot) {
	assertSiteId(siteId);
	if (!SHADOW_SLOTS.includes(Number(slot))) {
		throw new Error(`shadow slot must be one of ${SHADOW_SLOTS.join(', ')}, got ${slot}`);
	}
	return `10.${siteId}.${slot}.0/24`;
}

/** What a peer gateway is allowed to send us traffic for. */
const peerAllowedIps = (siteId) => [`${MESH_PREFIX}.${assertSiteId(siteId)}/32`, siteCidr(siteId)];

/**
 * The hub's catch-all. NEVER includes 0.0.0.0/0: AllowedIPs is one trie per
 * interface, so a peer claiming the default route takes it away from every
 * other peer -- which is exactly what makes exit selection impossible on a
 * shared interface. Exits get interfaces of their own.
 */
const hubAllowedIps = () => ['10.0.0.0/8', '172.24.0.0/16'];

module.exports = {
	MAX_SITE_ID, MIN_SITE_ID, MESH_PREFIX, SHADOW_SLOTS,
	assertSiteId, meshAddress, meshIp, siteCidr, siteGatewayIp, siteGatewayCidr,
	clientPoolCidr, shadowCidr, peerAllowedIps, hubAllowedIps
};
