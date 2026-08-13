'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { isVirtualInterfaceName } = require('../../services/mdns_announce');

test('flags docker/podman/veth/etc bridge interfaces as virtual', () => {
	for (const name of [
		'docker0', 'docker_gwbridge', 'br-4f2a9c1e8b7d', 'veth1234abcd',
		'cni0', 'cni-podman0', 'flannel.1', 'virbr0', 'podman0', 'tun0',
		'tap0', 'lxcbr0', 'vnet0', 'wg0',
	]) {
		assert.strictEqual(isVirtualInterfaceName(name), true, `expected ${name} to be virtual`);
	}
});

test('does not flag real NIC names as virtual', () => {
	for (const name of ['eth0', 'ens18', 'enp3s0', 'wlan0', 'bond0', 'eno1']) {
		assert.strictEqual(isVirtualInterfaceName(name), false, `expected ${name} to NOT be virtual`);
	}
});
