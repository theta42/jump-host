'use strict';

// The notification feed: every model event that went out over the socket,
// replayed through the same read gates that decided who received it live.
//
// No per-recipient storage. utils/socket_pubsub already answers "who may see
// this", per row, so history is those events filtered by the same gate for
// whoever is asking. Unread is one watermark per user, not a flag per item.

const router = require('express').Router();
const socketPubsub = require('../utils/socket_pubsub');
const middleware = require('../middleware/auth');
const {recent} = require('../models/activity_event');
const {ActivitySeen} = require('../models/activity_seen');

const FEED_LIMIT = 200;

// The same context the socket builds, from a request instead — history must be
// the same decision as the live delivery, not a second implementation of it.
function contextForRequest(req){
	return {
		username: (req.user && (req.user.username || req.user.uid)) || null,
		groups: req.groups || [],
		isAdmin: middleware.isAdmin(req),
	};
}

function visibleTo(ctx, event){
	const canRead = socketPubsub.READERS[event.model];
	if(!canRead) return false;
	try{
		// Enough of a record for the gates: the identifying field is the pk for
		// most models, and `owner` covers the owner-scoped ones.
		return !!canRead(ctx, {
			created_by: event.owner || undefined,
			uid: event.owner || undefined,
		}, event.target);
	}catch(error){
		console.error(`[activity] read gate for '${event.model}' threw:`, error.message);
		return false;
	}
}

router.get('/', async function(req, res, next){
	try{
		const ctx = contextForRequest(req);
		const events = (await recent(FEED_LIMIT)).filter(e => visibleTo(ctx, e));

		let seenAt = 0;
		try{
			const row = await ActivitySeen.get(ctx.username);
			seenAt = Number(row.seen_at) || 0;
		}catch(error){ /* never looked; everything is unread */ }

		return res.json({
			results: events,
			unread: events.filter(e => Number(e.created_on) > seenAt).length,
			seen_at: seenAt,
		});
	}catch(error){
		next(error);
	}
});

router.put('/seen', async function(req, res, next){
	try{
		const seen_at = Number(req.body && req.body.seen_at) || Date.now();
		await ActivitySeen.set(contextForRequest(req).username, seen_at);
		return res.json({results: {seen_at}});
	}catch(error){
		next(error);
	}
});

module.exports = router;
