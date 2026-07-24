'use strict';

// Jump-host data API: active sessions, the audit log, and metrics. Admin-gated
// (mounted behind middleware.auth + requireAdmin in routes/api.js).

const router = require('express').Router();
const audit = require('../models/audit_event');
const metrics = require('../models/metrics');
const registry = require('../services/session_registry');

router.get('/sessions', (req, res) => {
	res.json({results: registry.list(), active: registry.count()});
});

router.get('/audit', async (req, res, next) => {
	try{
		const page = Math.max(0, parseInt(req.query.page, 10) || 0);
		const data = await audit.list({
			page,
			pageSize: Math.min(200, parseInt(req.query.pageSize, 10) || 50),
			uid: req.query.uid || undefined,
			target: req.query.target || undefined,
			status: req.query.status || undefined,
		});
		res.json(data);
	}catch(error){ next(error); }
});

router.get('/metrics', async (req, res, next) => {
	try{
		res.json({...(await metrics.summary()), active: registry.count()});
	}catch(error){ next(error); }
});

module.exports = router;
