'use strict';

// User authentication backend — LDAP in production, ORM-backed file store in
// standalone mode. Both export the same interface:
//   getUser(uid)            -> { dn, uid, sshPublicKeys: [] } or null
//   getGroups(dn)           -> [cn, ...]
//   checkPassword(dn, pw)   -> bool
//   addSshKey(dn, keyLine)  -> void        (idempotent)

const conf = require('@simpleworkjs/conf');

if (conf.standalone && conf.standalone.enabled) {
	// Standalone mode: use the ORM-backed user store.
	module.exports = require('./user_file');
} else {
	// Production mode: use the LDAP directory.
	const { createLdapClient } = require('@simpleworkjs/ldap');
	const ldapConf = conf.ldap || {};
	module.exports = createLdapClient({
		...ldapConf,
		tlsOptions: ldapConf.tlsOptions || { rejectUnauthorized: false },
	});
}