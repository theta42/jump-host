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
	function hosts(cb){ app.api.get('user/hosts', cb); }
	return {metrics: metrics, sessions: sessions, audit: audit, hosts: hosts};
})(app);

// Self-service API token (PAT) management.
app.apiToken = (function(app){
	function list(cb){ app.api.get('api-token/', cb); }
	function add(args, cb){ app.api.post('api-token/', args, cb); }
	function remove(id, cb){ app.api.delete('api-token/' + id, cb); }
	function rotate(id, cb){ app.api.post('api-token/' + id + '/rotate', {}, cb); }
	return {list: list, add: add, remove: remove, rotate: rotate};
})(app);

// Shared render helpers.
app.jump.fmtTime = function(ts){ return ts ? moment(Number(ts)).format('YYYY-MM-DD HH:mm:ss') : '—'; };
app.jump.esc = function(s){ return $('<div>').text(s == null ? '' : String(s)).html(); };
app.jump.result = function(e){ return e.success ? '<span class="badge bg-success">ok</span>'
	: '<span class="badge bg-danger">' + app.jump.esc(e.failReason || 'fail') + '</span>'; };
