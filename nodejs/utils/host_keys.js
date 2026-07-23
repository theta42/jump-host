'use strict';

// Jump host SSH identity: one keypair used both as the server host key and
// as the client key for upstream connections (the public half is what gets
// injected into users' sshPublicKey — see utils/key_inject.js).
//
// Generated on first boot into conf.ssh.hostKeyPath:
//   ed25519  (id_ed25519 / id_ed25519.pub)  — primary
//   rsa-3072 (id_rsa / id_rsa.pub)          — compatibility host key
//
// Node's crypto generates the keys; ssh2's parseKey consumes the PEMs and
// renders the OpenSSH-format public lines.

const fs = require('fs');
const path = require('path');
const { utils: { parseKey, generateKeyPairSync } } = require('ssh2');
const conf = require('@simpleworkjs/conf');

// ssh2's parseKey wants OpenSSH-format private keys (Node's crypto PKCS8 export
// isn't accepted for ed25519), so use ssh2's own generator.
function generatePair(type) {
	const { private: priv } = generateKeyPairSync(type === 'ed25519' ? 'ed25519' : 'rsa',
		type === 'ed25519' ? undefined : { bits: 3072 });
	return priv;
}

function pubLine(privPem, comment) {
	const parsed = parseKey(privPem);
	if (parsed instanceof Error) throw parsed;
	const key = Array.isArray(parsed) ? parsed[0] : parsed;
	return `${key.type} ${key.getPublicSSH().toString('base64')} ${comment}`;
}

function ensureKeys(dir) {
	dir = dir || (conf.ssh && conf.ssh.hostKeyPath);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

	const out = {};
	for (const [type, name] of [['ed25519', 'id_ed25519'], ['rsa', 'id_rsa']]) {
		const priv = path.join(dir, name);
		if (!fs.existsSync(priv)) {
			const pem = generatePair(type);
			fs.writeFileSync(priv, pem, { mode: 0o600 });
			fs.writeFileSync(`${priv}.pub`, pubLine(pem, conf.ssh.keyComment) + '\n', { mode: 0o644 });
		}
		out[type] = fs.readFileSync(priv, 'utf8');
	}

	return {
		hostKeys: [out.ed25519, out.rsa],
		clientKey: out.ed25519,
		publicLine: pubLine(out.ed25519, conf.ssh.keyComment),
	};
}

module.exports = { ensureKeys, pubLine, generatePair };
