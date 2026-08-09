'use strict';

// Renders a WireGuard client wg0.conf from a peer + site record.
//
// The generated config is a standard WireGuard config that works with:
//   - wg-quick (Linux / macOS)
//   - the official WireGuard iOS / Android apps (via QR code)
//   - TunnelBear, WireGuard Windows client, etc.

/**
 * Build a client wg0.conf string.
 *
 * @param {object} peer       - WG peer record from wg_peer model
 * @param {object} site       - Exit node record from wg_site model (may be null)
 * @param {string} serverPub  - Gateway server's own public key
 * @param {string} serverEndpoint - "host:port" for the gateway
 * @param {string} dns        - Optional DNS server to push to client
 * @returns {string}
 */
function renderClientConf({ peer, site, serverPub, serverEndpoint, dns }) {
	const allowedIPs = site
		? (site.exitAll ? '0.0.0.0/0, ::/0' : site.subnet || '0.0.0.0/0')
		: '0.0.0.0/0, ::/0'; // no exit site = full tunnel

	const lines = [
		'[Interface]',
		`PrivateKey = ${peer.privateKey}`,
		`Address = ${peer.assignedIP}/32`,
	];

	if (dns) lines.push(`DNS = ${dns}`);

	lines.push('');
	lines.push('[Peer]');
	lines.push(`PublicKey = ${serverPub}`);

	// If client selected an exit site, add preshared key routing hint via
	// AllowedIPs. Site gateways are peers-of-peers; the server handles routing.
	if (site) {
		lines.push(`AllowedIPs = ${allowedIPs}`);
	} else {
		lines.push('AllowedIPs = 0.0.0.0/0, ::/0');
	}

	lines.push(`Endpoint = ${serverEndpoint}`);
	lines.push('PersistentKeepalive = 25');

	if (peer.note) {
		lines.unshift(`# ${peer.note}`);
	}

	return lines.join('\n') + '\n';
}

/**
 * Build a minimal server-side [Peer] block for wg0.conf (for reference/export).
 */
function renderServerPeerBlock(peer) {
	return [
		`# ${peer.name || peer.id}`,
		'[Peer]',
		`PublicKey = ${peer.publicKey}`,
		`AllowedIPs = ${peer.assignedIP}/32`,
		'',
	].join('\n');
}

module.exports = { renderClientConf, renderServerPeerBlock };
