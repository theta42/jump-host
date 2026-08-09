'use strict';

// WireGuard key generation using Node's built-in crypto (X25519).
// WireGuard keys ARE X25519 keys in raw base64 — no wg binary needed.

const crypto = require('crypto');

/**
 * Generate a WireGuard keypair.
 * @returns {{ privateKey: string, publicKey: string }} — base64 encoded
 */
function generateKeypair() {
	const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519', {
		publicKeyEncoding: { type: 'spki', format: 'der' },
		privateKeyEncoding: { type: 'pkcs8', format: 'der' },
	});

	// DER-encoded PKCS#8 private key: raw 32-byte X25519 scalar starts at offset 16
	const rawPriv = privateKey.slice(16, 48);
	// DER-encoded SPKI public key: raw 32-byte point starts at offset 12
	const rawPub = publicKey.slice(12, 44);

	return {
		privateKey: rawPriv.toString('base64'),
		publicKey: rawPub.toString('base64'),
	};
}

module.exports = { generateKeypair };
