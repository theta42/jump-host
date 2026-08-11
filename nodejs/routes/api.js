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

// WireGuard peer + site management — admin only.
router.use('/wireguard', middleware.auth, middleware.requireJumpAdmin, require('./wireguard'));

// Gateway-to-gateway mesh — mixed auth (register/register-* are called by a
// remote gateway with a bearer join token, not an admin session; join-tokens
// mint + join are admin-gated). See routes/mesh.js for the per-route gates.
// MUST be registered before the '/' mount below: '/' matches every /api/*
// path (it's the catch-all for routes/jump.js), so registering it first
// would shadow every /api/mesh/* route with admin-session auth before
// routes/mesh.js's own per-route gates ever ran -- confirmed live, this
// silently 401'd /register's bearer-join-token callers with a
// checkApiToken/LoginFailed error instead of ever reaching mesh.js.
router.use('/mesh', require('./mesh'));

// Jump-host data — jump admin only (audit log, active sessions, metrics).
router.use('/', middleware.auth, middleware.requireJumpAdmin, require('./jump'));

module.exports = router;
