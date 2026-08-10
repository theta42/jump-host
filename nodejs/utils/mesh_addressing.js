'use strict';

// Mesh subnet addressing math (MULTI_SITE_SPEC.md Appendix A): one octet per
// site, 172.24.<idx>.0/16 + 10.<idx>.0.0/16, idx 1-254 (0/255 reserved).
// Pure/no I/O so it's cheaply unit-testable apart from routes/mesh.js.

const MESH_SUBNET_PREFIX = '172.24';
const MAX_MESH_INDEX = 254;
const MIN_MESH_INDEX = 1;

function meshCidrFor(meshIndex) {
	assertValidIndex(meshIndex);
	return `${MESH_SUBNET_PREFIX}.${meshIndex}.1/24`;
}

function meshAllowedIpsFor(meshIndex) {
	assertValidIndex(meshIndex);
	return [`${MESH_SUBNET_PREFIX}.${meshIndex}.0/24`, `10.${meshIndex}.0.0/16`];
}

function assertValidIndex(meshIndex) {
	if (!Number.isInteger(meshIndex) || meshIndex < MIN_MESH_INDEX || meshIndex > MAX_MESH_INDEX) {
		throw new Error(`mesh index must be an integer in [${MIN_MESH_INDEX}, ${MAX_MESH_INDEX}], got ${meshIndex}`);
	}
}

module.exports = { meshCidrFor, meshAllowedIpsFor, MESH_SUBNET_PREFIX, MAX_MESH_INDEX, MIN_MESH_INDEX };
