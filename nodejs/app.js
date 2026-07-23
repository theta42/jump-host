'use strict';

const path = require('path');
const express = require('express');
const conf = require('@simpleworkjs/conf');

const registry = require('./services/session_registry');
const { requireAdmin } = require('./middleware/auth');
const buildInfo = require('./models/build_info');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Open health check — no auth (used by Docker/compose + the proxy).
app.get('/health', (req, res) => {
	res.json({ status: 'ok', activeSessions: registry.count(), version: buildInfo.version, commit: buildInfo.commit });
});

// Login routes (no session required).
app.use('/', require('./routes/auth'));

// Everything else requires an admin session.
app.use(requireAdmin);
app.use('/api', require('./routes/api'));
app.use('/', require('./routes/index'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
	console.error(err);
	if (req.path.startsWith('/api/')) return res.status(500).json({ error: err.message });
	res.status(500).render('login', { error: 'Internal error.', name: conf.name });
});

module.exports = app;
