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

// Jump-host data — jump admin only (audit log, active sessions, metrics).
router.use('/', middleware.auth, middleware.requireJumpAdmin, require('./jump'));

module.exports = router;
