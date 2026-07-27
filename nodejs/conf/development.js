'use strict';

module.exports = {
	ssh: {
		hostKeyPath: './data/keys',
	},
	standalone: {
		enabled: true,
	},
	orm: {
		dialect: 'sqlite',
		storage: './data/standalone.sqlite',
		logging: false,
	},
};
