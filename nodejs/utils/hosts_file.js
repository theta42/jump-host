'use strict';

// ORM-backed host inventory for standalone mode. Implements the same interface
// as utils/access.js so ssh_server.js works unchanged: accessibleHosts(user)
// returns an array of host resources the user may reach.
//
// In standalone mode all hosts in the inventory are accessible to every
// authenticated user — there is no group-based filtering. The _user parameter
// is accepted for interface compatibility but ignored.

const StandaloneHost = require('../models/standalone_host');

async function accessibleHosts(_user) {
  const hosts = await StandaloneHost.list({ where: { kind: 'host' } });
  // The ORM returns model instances; map to plain objects matching the shape
  // that target_match.js and tui_picker.js expect.
  return hosts.map((h) => ({
    id: h.slug, // slug doubles as the stable id in standalone mode
    kind: h.kind,
    slug: h.slug,
    displayName: h.displayName,
    metadata: h.metadata || {},
  }));
}

function clearCache() {
  // No cache in standalone mode — every call reads from the DB.
}

module.exports = { accessibleHosts, clearCache };
