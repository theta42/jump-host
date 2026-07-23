'use strict';

// Short git commit, baked into /app/.build_commit at image build time (see
// Dockerfile gitinfo stage) or resolved from git on bare metal.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function resolve() {
	try {
		const baked = path.join(__dirname, '../../.build_commit');
		if (fs.existsSync(baked)) return fs.readFileSync(baked, 'utf8').trim();
	} catch (_) {}
	try {
		return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
	} catch (_) {}
	return 'unknown';
}

let version = 'unknown';
try { version = require('../package.json').version; } catch (_) {}

module.exports = { commit: resolve(), version };
