'use strict';

const path = require('path');
const express = require('express');
const router = require('express').Router();
const conf = require('@simpleworkjs/conf');
const buildInfo = require('../utils/build_info');
const registry = require('../services/session_registry');
const { safeInternalPath } = require('@simpleworkjs/oidc-client');
const { mountStaticModules } = require('@simpleworkjs/app-stack');

const values = {
	title: conf.environment !== 'production' ? 'dev' : '',
	titleIcon: conf.environment !== 'production' ? '<i class="fa-brands fa-dev"></i>' : '',
	name: conf.name,
	logo: conf.logo,
	...buildInfo,
};

// Serve front-end vendor libraries straight from node_modules (same convention
// as the sibling apps), and the app's own JS/CSS/img from public/.
mountStaticModules(router, {
	root: path.join(__dirname, '..'),
	deps: ['bootstrap', 'mustache', 'jquery', '@fortawesome', 'moment', 'jq-repeat', '@simpleworkjs/frontend'],
});

// Liveness probe — no auth.
router.get('/health', (req, res) => {
	res.json({status: 'ok', activeSessions: registry.count(), buildVersion: buildInfo.buildVersion, buildHash: buildInfo.buildHash});
});

router.get('/', (req, res) => res.redirect(302, '/dashboard'));

// Page shells. The client framework (app-base.js + app.js) loads data via the
// authenticated /api/* endpoints and gates the UI on /api/user/me, so these
// render unauthenticated (like the sibling apps) and the client redirects to
// /login when there's no valid session.
router.get('/login', (req, res) => res.render('login', {
	...values,
	redirect: safeInternalPath(req.query.redirect || '/'),
	oidcEnabled: !!(conf.oidc && conf.oidc.enabled),
}));
router.get('/dashboard', (req, res) => res.render('dashboard', {...values}));
router.get('/sessions', (req, res) => res.render('sessions', {...values}));
router.get('/audit', (req, res) => res.render('audit', {...values}));

module.exports = router;
