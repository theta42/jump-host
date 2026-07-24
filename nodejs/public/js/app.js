'use strict';

// Jump-host page controllers. app.api / app.auth come from app-base.js (the
// shared client framework); this adds the jump-host data calls and the small
// render helpers each page uses.

app.jump = (function(app){
	function metrics(cb){ app.api.get('metrics', cb); }
	function sessions(cb){ app.api.get('sessions', cb); }
	function audit(query, cb){
		var qs = $.param(query || {});
		app.api.get('audit' + (qs ? '?' + qs : ''), cb);
	}
	return {metrics: metrics, sessions: sessions, audit: audit};
})(app);

// Shared render helpers.
app.jump.fmtTime = function(ts){ return ts ? moment(Number(ts)).format('YYYY-MM-DD HH:mm:ss') : '—'; };
app.jump.esc = function(s){ return $('<div>').text(s == null ? '' : String(s)).html(); };
app.jump.result = function(e){ return e.success ? '<span class="badge bg-success">ok</span>'
	: '<span class="badge bg-danger">' + app.jump.esc(e.failReason || 'fail') + '</span>'; };
