'use strict';

// Thin LDAP helpers — the jump host's entire LDAP surface:
//   getUser(uid)            -> { dn, uid, sshPublicKeys: [] } or null
//   getGroups(dn)           -> [cn, ...]   (groupOfNames membership)
//   checkPassword(dn, pw)   -> bool        (simple bind as the user)
//   addSshKey(dn, keyLine)  -> void        (idempotent multi-value add)
//
// Mirrors the patterns in sso-manager-node/nodejs/models/user_ldap.js and
// group_ldap.js (ldapts, admin-bound search, bind-as-user password check,
// TypeOrValueExists treated as success on key add).

const { Client, Change, Attribute } = require('ldapts');
const conf = require('@simpleworkjs/conf');

function ldapConf() {
	return conf.ldap || {};
}

function makeClient() {
	const c = ldapConf();
	return new Client({
		url: c.url,
		tlsOptions: c.tlsOptions || { rejectUnauthorized: false },
	});
}

// Escape a value being interpolated into an LDAP filter (RFC 4515).
function escapeFilter(value) {
	return String(value).replace(/[\\*()\0]/g, (ch) => ({
		'\\': '\\5c', '*': '\\2a', '(': '\\28', ')': '\\29', '\0': '\\00',
	}[ch]));
}

async function withClient(fn) {
	const c = ldapConf();
	const client = makeClient();
	try {
		await client.bind(c.bindDN, c.bindPassword);
		return await fn(client);
	} finally {
		await client.unbind().catch(() => {});
	}
}

async function getUser(uid) {
	const c = ldapConf();
	const attr = c.userNameAttribute || 'uid';
	return withClient(async (client) => {
		const { searchEntries } = await client.search(c.userBase, {
			scope: 'sub',
			filter: `(&(objectClass=posixAccount)(${attr}=${escapeFilter(uid)}))`,
			attributes: ['dn', attr, 'cn', 'sshPublicKey'],
		});
		if (!searchEntries.length) return null;
		const e = searchEntries[0];
		let keys = e.sshPublicKey || [];
		if (!Array.isArray(keys)) keys = [keys];
		return {
			dn: e.dn,
			uid: String(e[attr]),
			sshPublicKeys: keys.map(String),
		};
	});
}

async function getGroups(dn) {
	const c = ldapConf();
	return withClient(async (client) => {
		const { searchEntries } = await client.search(c.groupBase, {
			scope: 'sub',
			filter: `(&(objectClass=groupOfNames)(member=${escapeFilter(dn)}))`,
			attributes: ['cn'],
		});
		return searchEntries.map((e) => String(e.cn));
	});
}

async function checkPassword(dn, password) {
	if (!password) return false;
	const client = makeClient();
	try {
		await client.bind(dn, password);
		return true;
	} catch (_) {
		return false;
	} finally {
		await client.unbind().catch(() => {});
	}
}

async function addSshKey(dn, keyLine) {
	return withClient(async (client) => {
		try {
			await client.modify(dn, [
				new Change({
					operation: 'add',
					modification: new Attribute({ type: 'sshPublicKey', values: [keyLine] }),
				}),
			]);
		} catch (error) {
			// Same de-dup semantics as the SSO's User.addSSHkey.
			if (error.name === 'TypeOrValueExistsError') return;
			throw error;
		}
	});
}

module.exports = { getUser, getGroups, checkPassword, addSshKey, escapeFilter, makeClient };
