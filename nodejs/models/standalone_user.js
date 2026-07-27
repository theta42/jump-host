'use strict';

// ORM model for standalone-mode users. Stored in the configured SQL database
// (default SQLite) when conf.standalone.enabled is true. The user_file.js
// wrapper translates between this model and the LDAP-client interface that
// ssh_server.js and key_inject.js expect.

const { Model, fields } = require('@simpleworkjs/orm');

// Patch: StringField.toSequelize() and IntegerField.toSequelize() don't pass
// through primaryKey / autoIncrement (unlike UUIDField which does). Fix them
// so string and int primary keys work.
const origStringToSeq = fields.StringField.prototype.toSequelize;
fields.StringField.prototype.toSequelize = function () {
  const def = origStringToSeq.call(this);
  if (this.primaryKey) def.primaryKey = true;
  return def;
};
const origIntToSeq = fields.IntegerField.prototype.toSequelize;
fields.IntegerField.prototype.toSequelize = function () {
  const def = origIntToSeq.call(this);
  if (this.primaryKey) def.primaryKey = true;
  if (this.autoIncrement) def.autoIncrement = true;
  return def;
};

class StandaloneUser extends Model {
  static fields = {
    uid: { type: 'string', primaryKey: true },
    passwordHash: { type: 'string', isPrivate: true },
    sshPublicKeys: { type: 'json', default: [] },
    groups: { type: 'json', default: [] },
  };
}

module.exports = StandaloneUser;
