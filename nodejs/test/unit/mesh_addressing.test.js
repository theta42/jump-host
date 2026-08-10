'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { meshCidrFor, meshAllowedIpsFor, MAX_MESH_INDEX, MIN_MESH_INDEX } = require('../../utils/mesh_addressing');

test('meshCidrFor renders the .1 address in the site\'s /24', () => {
	assert.equal(meshCidrFor(1), '172.24.1.1/24');
	assert.equal(meshCidrFor(254), '172.24.254.1/24');
});

test('meshAllowedIpsFor covers both the mesh /24 and the site\'s 10.x/16', () => {
	assert.deepEqual(meshAllowedIpsFor(5), ['172.24.5.0/24', '10.5.0.0/16']);
});

test('rejects index 0 and 255 (reserved) and the out-of-range/non-integer cases', () => {
	assert.throws(() => meshCidrFor(0));
	assert.throws(() => meshCidrFor(255));
	assert.throws(() => meshCidrFor(MAX_MESH_INDEX + 1));
	assert.throws(() => meshCidrFor(MIN_MESH_INDEX - 1));
	assert.throws(() => meshCidrFor(1.5));
	assert.throws(() => meshCidrFor('1'));
});

test('MAX_MESH_INDEX matches the documented 254-site ceiling', () => {
	assert.equal(MAX_MESH_INDEX, 254);
});
