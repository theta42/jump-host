'use strict';

/**
 * Per-socket authorization for model events pushed over Socket.IO.
 *
 * This app pushed nothing before — bin/www attached socket.io only so the
 * shared front-end kept working. Everything here arrives with its read gate
 * rather than after one, which is the ordering the sibling apps had to be
 * retrofitted into: proxy grew live updates first and authorization second, and
 * in between every authenticated user received every payload.
 *
 * READERS is the single source of truth. A model listed here both publishes
 * (LIVE_MODELS is derived from it, and utils/model_events only forwards those)
 * and is authorized here, so the two cannot drift.
 */

const conf = require('@simpleworkjs/conf');

// Mirrors middleware/auth.isJumpAdmin: the local admin groups, plus the
// configured jump-admin groups (app_jump_admin by default).
function isJumpAdmin(ctx){
	const groups = ctx.groups || [];
	const adminGroups = (conf.auth && conf.auth.adminGroups) || [];
	const jumpAdminGroups = (conf.auth && conf.auth.jumpAdminGroups) || [];
	if (ctx.isAdmin) return true;
	return groups.some(g => adminGroups.includes(g) || jumpAdminGroups.includes(g));
}

const READERS = {
	// Self-service PATs (routes/api_token.js) — owner-scoped, and deliberately
	// no admin bypass: a personal access token is nobody else's business, and
	// the REST route has no admin path either.
	ApiToken(ctx, record, pk){
		const self = ctx.username;
		const owner = record && record.created_by;
		return !!self && !!owner && String(owner) === String(self);
	},

	// The SSH audit trail — who connected to what. routes/jump.js is mounted
	// behind requireJumpAdmin for the whole router, so this matches it.
	AuditEvent(ctx){
		return isJumpAdmin(ctx);
	},
};

// Only models with a gate reach the bus at all: publishing something ungated
// would be a leak, gating something that never publishes would be dead code.
const LIVE_MODELS = new Set(Object.keys(READERS));

const warnedModels = new Set();

// `model:AuditEvent:create:<id>` -> {model, action, pk}
// A pk may contain ':', so the tail is rejoined rather than split off.
function parseTopic(topic){
	const parts = String(topic || '').split(':');
	if(parts[0] !== 'model' || parts.length < 3) return null;
	return {
		model: parts[1],
		action: parts[2],
		pk: parts.length > 3 ? parts.slice(3).join(':') : undefined,
	};
}

/**
 * The bus every model publishes through. Bound into utils/model_events at boot;
 * filters to LIVE_MODELS so an ungated model cannot reach a browser.
 */
function liveBus(ps){
	return {
		publish(topic, data){
			if(!data || !LIVE_MODELS.has(data.model)) return;
			ps.publish(topic, data);
			// Every event that goes out is a notification, so this is also
			// where history is recorded. Not awaited: a session must not wait
			// on its history row.
			require('../models/activity_event').record(data);
		},
		subscribe(pattern, listener){
			return ps.subscribe(pattern, listener);
		},
	};
}

function contextForSocket(socket){
	return {
		username: socket.user && (socket.user.username || socket.user.uid),
		groups: socket.groups || [],
		isAdmin: !!socket.isAdmin,
	};
}

function attach(io, ps){
	ps.subscribe(/^model:/, function(data, topic){
		const event = parseTopic(topic);
		if(!event) return;

		const canRead = READERS[event.model];
		if(!canRead){
			if(!warnedModels.has(event.model)){
				warnedModels.add(event.model);
				console.warn(`[socket_pubsub] no read gate for model '${event.model}'; its events are not broadcast. Add it to READERS in utils/socket_pubsub.js.`);
			}
			return;
		}

		for(const socket of io.sockets.sockets.values()){
			if(!socket.user) continue;
			let allowed = false;
			try{
				allowed = canRead(contextForSocket(socket), data && data.data, event.pk);
			}catch(error){
				console.error(`[socket_pubsub] read gate for '${event.model}' threw:`, error);
				allowed = false;
			}
			if(allowed) socket.emit('P2PSub', {topic, data});
		}
	});

	// Deliberately no `socket.on('P2PSub')`: events flow server -> client only.
	// The sibling apps had an inbound handler that rebroadcast whatever a client
	// sent to every other client; nothing legitimate ever used it.
}

module.exports = {attach, parseTopic, liveBus, contextForSocket, READERS, LIVE_MODELS};
