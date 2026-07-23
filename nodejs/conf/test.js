'use strict';

module.exports = {
	redis: {
		prefix: 'jump_host_test_',
	},
	ssh: {
		listenPort: 0, // ephemeral in tests
		hostKeyPath: '/tmp/jump-host-test-keys',
	},
	web: {
		port: 0,
	},
};
