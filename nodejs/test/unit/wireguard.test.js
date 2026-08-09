'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeypair } = require('../../utils/wg_keys');
const { renderClientConf } = require('../../utils/wg_conf');

test('generateKeypair returns valid base64 WireGuard keypair', () => {
	const kp = generateKeypair();
	assert.ok(kp.privateKey, 'privateKey should exist');
	assert.ok(kp.publicKey, 'publicKey should exist');
	assert.notEqual(kp.privateKey, kp.publicKey);
	// WireGuard raw X25519 base64 keys are 44 characters ending with '='
	assert.equal(kp.privateKey.length, 44);
	assert.equal(kp.publicKey.length, 44);
});

test('renderClientConf generates valid wg0 client configuration', () => {
	const peer = {
		name: 'test-phone',
		assignedIP: '10.100.0.5',
		privateKey: 'c3VwZXJzZWNyZXRwcml2YXRla2V5MTIzNDU2Nzg5MDE=',
	};
	const site = {
		subnet: '192.168.1.0/24',
		exitAll: false,
	};
	const confStr = renderClientConf({
		peer,
		site,
		serverPub: 'c2VydmVycHVibGlja2V5MTIzNDU2Nzg5MDEyMzQ1Njc=',
		serverEndpoint: 'gw.theta42.com:51820',
		dns: '1.1.1.1',
	});

	assert.ok(confStr.includes('[Interface]'));
	assert.ok(confStr.includes('PrivateKey = c3VwZXJzZWNyZXRwcml2YXRla2V5MTIzNDU2Nzg5MDE='));
	assert.ok(confStr.includes('Address = 10.100.0.5/32'));
	assert.ok(confStr.includes('[Peer]'));
	assert.ok(confStr.includes('PublicKey = c2VydmVycHVibGlja2V5MTIzNDU2Nzg5MDEyMzQ1Njc='));
	assert.ok(confStr.includes('Endpoint = gw.theta42.com:51820'));
});
