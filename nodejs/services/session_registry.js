'use strict';

// In-memory registry of live SSH sessions — feeds GET /api/sessions and the
// maxSessions cap. Ephemeral by design (a restart drops every bridge anyway).

const sessions = new Map(); // id -> descriptor

function add(id, desc) {
	sessions.set(id, { id, startedAt: Date.now(), ...desc });
}

function remove(id) {
	sessions.delete(id);
}

function list() {
	return [...sessions.values()];
}

function count() {
	return sessions.size;
}

module.exports = { add, remove, list, count };
