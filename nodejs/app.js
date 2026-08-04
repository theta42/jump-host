'use strict';

const express = require('express');
const compression = require('compression');

require('./models'); // wire model-redis + register models
const conf = require('@simpleworkjs/conf');
const buildInfo = require('./utils/build_info');

const app = express();

app.set('view engine', 'ejs');
app.set('views', require('path').join(__dirname, 'views'));

// Per-app values for the shared UI shell (views/top.ejs + views/bottom.ejs).
// Set as an app local so every res.render has it, including routes that don't
// spread the render router's `values` object.
app.locals.ui = require('./utils/ui');

app.use(compression());
app.use(express.json());
app.use(express.urlencoded({extended: false}));

// Page shells + static assets + /health (mostly unauthenticated; the client
// gates itself on /api/user/me and redirects to /login).
app.use('/', require('./routes/render'));

// API — auth handled per-router inside (see routes/api.js).
app.use('/api', require('./routes/api'));

// 404
app.use((req, res, next) => {
	const error = new Error('Not Found');
	error.status = 404;
	next(error);
});

// Error handler — JSON for API, redirect to login for pages on 401.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
	const status = err.status || 500;
	if(status >= 500) console.error(err);
	if(req.path.startsWith('/api/')){
		return res.status(status).json({name: err.name || 'Error', message: err.message || 'Error'});
	}
	// Browser navigation gets the HTML error page (shared with SSO).
	res.status(status).render('error', {
		title: conf.environment !== 'production' ? 'dev' : '',
		titleIcon: conf.environment !== 'production' ? '<i class="fa-brands fa-dev"></i>' : '',
		name: conf.name,
		logo: conf.logo,
		...buildInfo,
		error: err,
	});
});

module.exports = app;
