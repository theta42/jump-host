'use strict';

const router = require('express').Router();
const middleware = require('../middleware/auth');

// Authentication (local login + OIDC handshake). Unauthenticated by design.
router.use('/auth', require('../models').authRouter);

// Who am I — needs a valid session but no admin gate (drives the login state).
router.use('/user', middleware.auth, require('./user'));

// Self-service API token (PAT) management — any authenticated user, no
// admin gate (see routes/api_token.js for why a token can't reach admin routes).
router.use('/api-token', middleware.auth, require('./api_token'));

// The notification feed: model events replayed through the same read gates that
// decided who received them live (routes/activity.js). Mounted before the
// catch-all jump router below, which would otherwise swallow it.
router.use('/activity', middleware.auth, require('./activity'));

// Mesh diagnostics and manual reconcile. All mesh CONFIGURATION lives in the
// directory now (joining the directory is joining the mesh), so this is
// read-mostly -- but it keeps its own per-route gates.
//
// MUST be registered before the '/' mount below: '/' matches every /api/*
// path (it's the catch-all for routes/jump.js), so registering it first would
// shadow every /api/mesh/* route with the catch-all's auth before mesh.js's
// own gates ever ran -- confirmed live once already.
router.use('/mesh', require('./mesh'));

// Jump-host data — jump admin only (audit log, active sessions, metrics).
router.use('/', middleware.auth, middleware.requireJumpAdmin, require('./jump'));

module.exports = router;
