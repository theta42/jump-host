'use strict';

// Parse the jump host's SSH username grammar:
//
//   {uid}                      -> interactive TUI picker
//   {uid}_-_{target}           -> bridge straight to <target>
//
// where <target> is a directory host slug (with or without the host_ prefix),
// a bare hostname, or an IPv4 address. The separator `_-_` was chosen because
// it is legal in an SSH username everywhere (WinSCP included) and cannot
// appear in a POSIX uid. We split on the FIRST `_-_`: uids cannot contain it
// (POSIX uids don't allow the sequence in practice and the SSO's invite flow
// never generates one), while a target could in theory contain a later `-`
// sequence.
//
// Returns { uid, target } — target is null in picker mode.
// Throws on a syntactically invalid uid or target.

const SEP = '_-_';

// POSIX-ish uid: same shape the SSO enforces.
const UID_RE = /^[a-z_][a-z0-9._-]{0,31}$/;

// Directory slug chars (slugify output) or a hostname label string.
const TARGET_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIPv4(s) {
	const m = IPV4_RE.exec(s);
	if (!m) return false;
	return m.slice(1).every((o) => Number(o) <= 255);
}

function parseUsername(username) {
	if (typeof username !== 'string' || !username.length) {
		throw new Error('Empty username');
	}

	const idx = username.indexOf(SEP);
	if (idx === -1) {
		if (!UID_RE.test(username)) throw new Error(`Invalid username: ${username}`);
		return { uid: username, target: null };
	}

	const uid = username.slice(0, idx);
	const target = username.slice(idx + SEP.length);

	if (!UID_RE.test(uid)) throw new Error(`Invalid uid in username: ${uid}`);
	if (!target.length || (!TARGET_RE.test(target) && !isIPv4(target))) {
		throw new Error(`Invalid target in username: ${target}`);
	}

	return { uid, target };
}

module.exports = { parseUsername, isIPv4, SEP };
