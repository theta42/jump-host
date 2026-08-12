'use strict';

// Authorization for model events pushed over Socket.IO.
//
// Unlike the sibling apps, this one arrives with its read gate rather than
// after one: proxy grew live updates first and authorization second, and in
// between every authenticated user received every payload.

const test = require('node:test');
const assert = require('node:assert');

const {READERS, LIVE_MODELS, parseTopic} = require('../../utils/socket_pubsub');

const jumpAdmin = {username: 'root', groups: ['app_jump_admin'], isAdmin: false};
const plain = {username: 'alice', groups: ['staff'], isAdmin: false};

test('parseTopic splits a model event and rejoins a pk containing colons', () => {
	assert.deepStrictEqual(parseTopic('model:AuditEvent:create:abc'), {
		model: 'AuditEvent', action: 'create', pk: 'abc',
	});
	assert.strictEqual(parseTopic('model:X:update:a:b').pk, 'a:b');
	assert.strictEqual(parseTopic('nope'), null);
});

test('the SSH audit trail is jump-admin only', () => {
	// Who connected to which host is exactly what an ordinary user should not
	// be told about. routes/jump.js is behind requireJumpAdmin for the whole
	// router; this matches it.
	assert.strictEqual(READERS.AuditEvent(jumpAdmin), true);
	assert.strictEqual(READERS.AuditEvent(plain), false);
	assert.strictEqual(READERS.AuditEvent({username: 'x', groups: [], isAdmin: true}), true);
});

test('a PAT is visible only to the person who created it', () => {
	assert.strictEqual(READERS.ApiToken(plain, {created_by: 'alice'}), true);
	assert.strictEqual(READERS.ApiToken(plain, {created_by: 'bob'}), false);
	// Deliberately no admin bypass: the REST route has none either.
	assert.strictEqual(READERS.ApiToken(jumpAdmin, {created_by: 'alice'}), false);
});

test('an unidentifiable record is withheld rather than shared', () => {
	assert.strictEqual(READERS.ApiToken(plain, {}), false);
	assert.strictEqual(READERS.ApiToken(plain, null), false);
});

test('models without a gate are absent, so they never publish or broadcast', () => {
	// LIVE_MODELS derives from READERS, so an ungated model cannot reach the
	// bus at all. ActivityEvent in particular would record its own writes.
	assert.strictEqual(READERS.ActivityEvent, undefined);
	assert.strictEqual(READERS.ActivitySeen, undefined);
	assert.strictEqual(LIVE_MODELS.has('ActivityEvent'), false);
	assert.deepStrictEqual([...LIVE_MODELS].sort(), Object.keys(READERS).sort());
});

test('every gated model survives the reduced record the feed replays', () => {
	// History stores shape only, so the feed hands gates a partial record.
	const reduced = {created_by: 'alice', uid: 'alice'};
	for (const model of Object.keys(READERS)) {
		assert.doesNotThrow(() => READERS[model](plain, reduced, 'abc'), model);
	}
});
