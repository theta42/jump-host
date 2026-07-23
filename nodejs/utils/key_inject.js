'use strict';

// Upstream auth: the jump host connects to downstream hosts as the real user
// with the jump host's OWN private key. For downstream sshd to accept it, the
// jump host's public key must be one of the user's sshPublicKey values in
// LDAP (downstream hosts serve keys from LDAP via ldap-client's
// AuthorizedKeysCommand / SSSD).
//
// So: before the first upstream connect for a user, append the jump host's
// public line (comment-marked, e.g. "... jump-host@local") to their
// sshPublicKey attribute. Idempotent: exact-value duplicates are a no-op
// (TypeOrValueExists handled in models/user_ldap.addSshKey). The redis flag
// jump_host_injected_<uid> skips the LDAP round-trip on later connects; a
// failed upstream auth clears it so a manually-removed key gets re-injected
// once (see services/bridge.js).
//
// The bind DN therefore needs WRITE access to sshPublicKey on ou=people —
// documented in the README (OpenLDAP ACL) and granted by theta-env's
// bootstrap for the bundled deployment.

const conf = require('@simpleworkjs/conf');
const userLdap = require('../models/user_ldap');
const { getRedis } = require('../models');

function flagKey(uid) {
	return `${conf.redis.prefix}injected_${uid}`;
}

async function ensureKeyInjected(user, publicLine, { ldap = userLdap } = {}) {
	const redis = await getRedis();
	if (await redis.get(flagKey(user.uid))) return false;

	const already = (user.sshPublicKeys || []).includes(publicLine);
	if (!already) {
		await ldap.addSshKey(user.dn, publicLine);
	}
	await redis.set(flagKey(user.uid), '1');
	return !already; // true if we actually wrote (caller may pause for SSSD cache)
}

async function clearInjectedFlag(uid) {
	const redis = await getRedis();
	await redis.del(flagKey(uid));
}

module.exports = { ensureKeyInjected, clearInjectedFlag };
