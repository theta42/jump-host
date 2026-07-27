'use strict';

// ORM model for standalone-mode hosts. Stored in the configured SQL database
// (default SQLite) when conf.standalone.enabled is true. The hosts_file.js
// wrapper translates between this model and the accessibleHosts() interface
// that ssh_server.js expects.

const { Model, fields } = require('@simpleworkjs/orm');

// Patch StringField.toSequelize() to pass through primaryKey (same fix as in
// standalone_user.js — see that file for details).
if (!fields.StringField.prototype.toSequelize.toString().includes('primaryKey')) {
  const orig = fields.StringField.prototype.toSequelize;
  fields.StringField.prototype.toSequelize = function () {
    const def = orig.call(this);
    if (this.primaryKey) def.primaryKey = true;
    return def;
  };
}

class StandaloneHost extends Model {
  static fields = {
    slug: { type: 'string', primaryKey: true },
    displayName: { type: 'string' },
    kind: { type: 'string', default: 'host' },
    metadata: { type: 'json', default: {} },
  };
}

module.exports = StandaloneHost;
