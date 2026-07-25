'use strict';

// Unified build-info shape ({ buildVersion, buildHash, buildYear }) via the
// shared @simpleworkjs/app-stack. Previously this lived in models/build_info.js
// and exported { commit, version }; the shape is now aligned with sso + proxy.
//
// The baked commit file lives at the jump-host repo root (../../ from here in
// utils/), matching the Dockerfile gitinfo stage. cwd is utils/ for the
// bare-metal git fallback.

const path = require('path');
const { createBuildInfo } = require('@simpleworkjs/app-stack');
const { version } = require('../package.json');

module.exports = createBuildInfo({
	version,
	buildCommitPath: path.join(__dirname, '../../.build_commit'),
	cwd: __dirname,
});