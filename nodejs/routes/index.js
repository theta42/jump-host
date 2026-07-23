'use strict';

const express = require('express');
const audit = require('../models/audit_event');
const metrics = require('../models/metrics');
const registry = require('../services/session_registry');
const buildInfo = require('../models/build_info');
const conf = require('@simpleworkjs/conf');

const router = express.Router();

router.get('/', async (req, res, next) => {
	try {
		const [m, recent] = await Promise.all([
			metrics.summary(),
			audit.list({ page: 0, pageSize: 10 }),
		]);
		res.render('dashboard', {
			name: conf.name, buildInfo, user: req.jumpUser,
			metrics: { ...m, active: registry.count() },
			active: registry.list(),
			recent: recent.results,
		});
	} catch (err) { next(err); }
});

router.get('/sessions', (req, res) => {
	res.render('sessions', { name: conf.name, buildInfo, user: req.jumpUser, active: registry.list() });
});

router.get('/audit', async (req, res, next) => {
	try {
		const page = Math.max(0, parseInt(req.query.page, 10) || 0);
		const data = await audit.list({ page, pageSize: 50, uid: req.query.uid, target: req.query.target, status: req.query.status });
		res.render('audit', { name: conf.name, buildInfo, user: req.jumpUser, data, query: req.query });
	} catch (err) { next(err); }
});

module.exports = router;
