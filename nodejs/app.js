'use strict';

const express = require('express');
const compression = require('compression');

require('./models'); // wire model-redis + register models

const app = express();

app.set('view engine', 'ejs');
app.set('views', require('path').join(__dirname, 'views'));

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
	res.status(status).send(err.message || 'Error');
});

module.exports = app;
