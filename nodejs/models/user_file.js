'use strict';

// ORM-backed user store for standalone mode. Implements the same interface as
// the @simpleworkjs/ldap client so ssh_server.js and key_inject.js work
// unchanged: getUser(uid), getGroups(dn), checkPassword(dn, pw), addSshKey(dn, keyLine).
//
// Users are stored via the StandaloneUser ORM model (Sequelize, any dialect).
// DNs are synthetic: uid=<uid>,ou=people,dc=standalone,dc=local — the real
// identity is the uid; the DN exists only for interface compatibility with
// callers that thread user.dn through to checkPassword / addSshKey.

const bcrypt = require('bcrypt');
const StandaloneUser = require('./standalone_user');

const DN_PREFIX = 'uid=';
const DN_SUFFIX = ',ou=people,dc=standalone,dc=local';

function dnFor(uid) {
  return `${DN_PREFIX}${uid}${DN_SUFFIX}`;
}

function uidFromDn(dn) {
  if (!dn || typeof dn !== 'string') return null;
  const m = dn.match(/^uid=([^,]+)/);
  return m ? m[1] : null;
}

async function getUser(uid) {
  const user = await StandaloneUser.get(uid);
  if (!user) return null;
  return {
    dn: dnFor(user.uid),
    uid: user.uid,
    sshPublicKeys: user.sshPublicKeys || [],
  };
}

async function getGroups(dn) {
  const uid = uidFromDn(dn);
  if (!uid) return [];
  const user = await StandaloneUser.get(uid);
  if (!user) return [];
  return user.groups || [];
}

async function checkPassword(dn, pw) {
  const uid = uidFromDn(dn);
  if (!uid) return false;
  const user = await StandaloneUser.get(uid);
  if (!user || !user.passwordHash) return false;
  return bcrypt.compare(pw, user.passwordHash);
}

async function addSshKey(dn, keyLine) {
  const uid = uidFromDn(dn);
  if (!uid) return;
  const user = await StandaloneUser.get(uid);
  if (!user) return;
  const keys = [...(user.sshPublicKeys || [])];
  if (keys.includes(keyLine)) return; // idempotent
  keys.push(keyLine);
  await user.update({ sshPublicKeys: keys });
}

module.exports = { getUser, getGroups, checkPassword, addSshKey };
