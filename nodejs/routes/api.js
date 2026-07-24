'use strict';

const router = require('express').Router();
const middleware = require('../middleware/auth');

// Authentication (local login + OIDC handshake). Unauthenticated by design.
router.use('/auth', require('./auth'));

// Who am I — needs a valid session but no admin gate (drives the login state).
router.use('/user', middleware.auth, require('./user'));

// Jump-host data — admin only (audit log, active sessions, metrics).
router.use('/', middleware.auth, middleware.requireAdmin, require('./jump'));

module.exports = router;
