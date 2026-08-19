'use strict';

// Every nav link must point at a page that exists.
//
// The bug this pins: the mesh-v2 rewrite (e6ad8eb, "gateway becomes a
// roster-driven router") deleted views/wireguard.ejs and the `/wireguard`
// route, replacing them with `/mesh` -- but left the "WireGuard" entry in the
// nav. Every admin therefore saw a menu item that 404s, and it stayed that way
// across several releases because nothing connects the two files.
//
// Read as SOURCE rather than by booting the app: routes/render.js pulls in
// @simpleworkjs/conf, the session registry and the static-module mounter, none
// of which stand up under a bare unit test. What matters here is the
// relationship between the two declarations, and that is visible statically.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function renderedPaths() {
	const src = fs.readFileSync(path.join(ROOT, 'routes', 'render.js'), 'utf8');
	const out = new Set();
	for (const m of src.matchAll(/router\.get\(\s*'([^']+)'/g)) out.add(m[1]);
	return out;
}

function navHrefs() {
	const ui = require(path.join(ROOT, 'utils', 'ui.js'));
	return (ui.nav || []).map((item) => item.href);
}

test('every nav href has a matching render route', () => {
	const routes = renderedPaths();
	const hrefs = navHrefs();

	assert.ok(hrefs.length > 0, 'nav is empty — the parse above is wrong');

	const dangling = hrefs.filter((href) => !routes.has(href));
	assert.deepStrictEqual(
		dangling, [],
		`nav links with no route in routes/render.js: ${dangling.join(', ')}. ` +
		'Either add the route or drop the nav entry — a menu item that 404s is worse than a missing one.'
	);
});

test('every nav href has a view file to render', () => {
	const viewsDir = path.join(ROOT, 'views');
	const missing = navHrefs()
		.map((href) => href.replace(/^\//, ''))
		.filter((name) => !fs.existsSync(path.join(viewsDir, `${name}.ejs`)));

	assert.deepStrictEqual(missing, [], `nav entries with no views/<name>.ejs: ${missing.join(', ')}`);
});
