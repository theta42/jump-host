'use strict';

const conf = require('@simpleworkjs/conf');

/**
 * Requests a signed SSH certificate from the SSO Manager's OpenBao/Vault proxy.
 *
 * @param {string} publicKey - The jump host's public key (e.g. 'ssh-rsa AAAAB3...')
 * @param {string} targetUid - The username the cert should be valid for
 * @returns {Promise<string>} - The signed SSH certificate
 */
async function getSignedCert(publicKey, targetUid) {
	const sso = conf.sso || {};
	const pkiConfig = conf.ssh?.pki || {};
	
	const vaultRole = pkiConfig.role || 'jump-host-role';
	const endpoint = `${sso.url}/api/vault/ssh/sign/${vaultRole}`;

	const response = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${sso.apiToken}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			public_key: publicKey,
			valid_principals: targetUid
		})
	});

	if (!response.ok) {
		const errText = await response.text().catch(() => '');
		throw new Error(`Failed to sign SSH cert (status ${response.status}): ${errText}`);
	}

	const data = await response.json();
	if (!data.data || !data.data.signed_key) {
		throw new Error('Vault response missing signed_key');
	}

	return data.data.signed_key;
}

module.exports = { getSignedCert };
