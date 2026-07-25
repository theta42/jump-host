'use strict';

// Thin LDAP helpers — the jump host's entire LDAP surface, now backed by the
// shared @simpleworkjs/ldap package:
//   getUser(uid)            -> { dn, uid, sshPublicKeys: [] } or null
//   getGroups(dn)           -> [cn, ...]   (groupOfNames membership)
//   checkPassword(dn, pw)   -> bool        (simple bind as the user)
//   addSshKey(dn, keyLine)  -> void        (idempotent multi-value add)
//
// Behavior is unchanged from the previous in-tree implementation: posixAccount
// user filter, groupOfNames group filter, bind-as-user password check,
// TypeOrValueExists treated as success on key add, and the same loose TLS
// default ({ rejectUnauthorized: false } when conf.ldap omits tlsOptions).

const conf = require('@simpleworkjs/conf');
const { createLdapClient } = require('@simpleworkjs/ldap');

const ldapConf = conf.ldap || {};
module.exports = createLdapClient({
	...ldapConf,
	tlsOptions: ldapConf.tlsOptions || { rejectUnauthorized: false },
});