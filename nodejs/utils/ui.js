'use strict';

// Per-app values for the shared UI shell (views/top.ejs + views/bottom.ejs).
//
// Those two partials are byte-identical across sso-manager-node, proxy and
// jump-host — everything that differs between the apps lives here and is
// exposed to every render as `ui` via app.locals (see app.js). Keep the key set
// in sync across the three apps; a missing key is a render-time ReferenceError,
// not a silent fallback.

module.exports = {
	// --- footer -------------------------------------------------------------
	repoUrl: 'https://github.com/theta42/jump-host',
	licenseUrl: 'https://github.com/theta42/jump-host/blob/master/LICENSE',
	// No in-app /docs route here — point at the published docs site.
	docsUrl: 'https://theta42.github.io/jump-host/',
	docsExternal: true,
	// Only sso-manager-node serves a Terms of Service page; null hides the link.
	tosUrl: null,

	// --- header / nav -------------------------------------------------------
	faviconUrl: '/static/favicon.svg',
	// Where the current-user chip links. null renders it as a plain span (for
	// apps with no profile page).
	profileUrl: null,
	// Where "Log Out" lands.
	logoutRedirect: '/login',
	// Admin-only "a newer release is available" banner, backed by
	// GET /api/update-check. Apps without that endpoint set false.
	updateCheck: false,
	updateLabel: 'the jump host',

	// Nav items, in order. `groups` is an OR-list of group CNs that may see the
	// item; an empty list means "always visible". Gating is done client-side by
	// app-base.js, which reveals .group-required-<cn> for each group the user is
	// in (plus the synthetic `admin` group when user/me reports isAdmin).
	nav: [
		{href: '/dashboard', icon: 'fa-solid fa-gauge-high', label: 'Dashboard', groups: []},
		{href: '/sessions', icon: 'fa-solid fa-plug-circle-bolt', label: 'Sessions', groups: []},
		{href: '/audit', icon: 'fa-solid fa-clipboard-list', label: 'Audit', groups: ['admin', 'app_jump_admin']},
	],
};
