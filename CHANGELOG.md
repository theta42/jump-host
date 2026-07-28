# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
correspond to git tags (`vX.Y.Z`) and `nodejs/package.json`'s `version`.

## [1.8.2] - 2026-07-28

### Fixed
- **Audit records for a failed upstream connection only ever said `upstream-unreachable`** — `resolveAndConnect` discarded the real error from `connectUpstream` (ECONNREFUSED, ETIMEDOUT, an ssh2 auth-failure message, etc.) and replaced it with that one generic string, so there was no way to tell a network-layer failure from an auth failure from the audit log alone. This is what blocked root-causing the "Could not reach 192.168.1.206" (emby host) report — the real error is now captured and surfaced as a new `failDetail` field on the audit record, shown as a tooltip on the fail badge in the admin audit table.

## [1.8.1] - 2026-07-28

### Fixed
- **Redis had zero persistence** (`--save '' --appendonly no`, no data-dir volume) — every container rebuild/recreation silently wiped all sessions, in-flight OAuth logins, and any admin-created API token. This is why re-running `setup.sh` appeared to "break OAuth with jump": the jump-host container gets recreated, and any token or in-flight login vanished with it. Now Redis persists (AOF + periodic RDB) to `/data`, mounted as a named volume (`jump-redis-data`) in theta-env's compose file. Verified live: minted a PAT, force-recreated the container, confirmed the same PAT still authenticated afterward.

## [1.8.0] - 2026-07-28

### Fixed
- **TUI-mode SSH connections (a bare `ssh user@host`, no target) could drop with "PTY allocation request failed" / "shell request failed"** — `runTuiSession` awaited two real round-trips (an audit-log write, then a directory API call) *before* attaching the session's pty/shell/exec listeners, so a client that sent those requests quickly enough got auto-rejected by ssh2 before anything was listening. `runGrammar` (the `uid_-_target` path) already had the equivalent fix; this ports it to the picker path.
- **`formAJAX`'s loading indicator showed literal HTML**, not a spinner — same fix as sso-manager-node/proxy's companion releases.

## [1.7.1] - 2026-07-28

### Added
- **Regression test**: a static check across all views/client-side scripts fails CI if any native `alert()`/`confirm()`/`prompt()` call appears — these block all further browser events on the page. This app has never had one; keeps it that way.

## [1.7.0] - 2026-07-27

### Added
- **Self-service API tokens (PATs)** — `models/api_token.js` + `routes/api_token.js` (mounted at `/api-token`), Bearer-token support in `middleware/auth.js`, and a create/list/rotate/revoke card on the dashboard. Ports proxy's `jmp_<id>_<secret>` pattern; unlike proxy's, a jump-host token carries no group claims, so it authenticates as its creator for non-admin routes only (never passes `requireAdmin`). jump-host previously had no PAT support at all.

## [1.6.0] - 2026-07-27

### Changed
- **Adopted `@simpleworkjs/frontend`'s `app.messages`, `app.modal`, and `app.validate` modules**, replacing the vendored `app.util.actionMessage`/`actionConfirm` in `public/lib/js/app-base.js` and the vendored `public/lib/js/val.js` (unused by any current view here, so this is dedup/future-proofing rather than a behavior change). `app.api`/`app.auth`/`app.pubsub`/`app.socket` are untouched.

## [1.5.0] - 2026-07-27

### Added
- **Web UI dashboard now lists the hosts you can reach** ("Hosts you can reach", or "All hosts" for admins) — previously the dashboard only showed usage metrics, with no way to see your actual access from the browser. Backed by a new `GET /api/user/hosts` endpoint (auth-only, not admin-gated): admins get the full inventory via `utils/access.js`'s new `allHosts()`, everyone else gets the same group-based resolution the SSH front door uses.
- `utils/access.js`'s `accessibleHosts()` now accepts a pre-resolved `groups` array on the user object, skipping the LDAP `getGroups(dn)` round-trip — the web UI's OIDC session already has its groups claim and has no LDAP `dn` to query with.

### Fixed
- **Bumped `@simpleworkjs/ldap` to 1.0.1**, which fixes `addSshKey` throwing `ObjectClassViolationError` (LDAP `0x41`) on accounts predating the `ldapPublicKey` auxiliary objectClass. This is the code path this jump host's key-injection (`utils/key_inject.js`) uses on every first connection for a user — on affected accounts it aborted the SSH connection entirely (`key-inject-failed`).

## [1.4.0] - 2026-07-26

### Added
- **Standalone mode** — run the jump host with no LDAP directory and no SSO Manager at all. Set `standalone.enabled: true` and user authentication and host discovery switch to `@simpleworkjs/orm`-backed stores (Sequelize; SQLite by default, any Sequelize-supported dialect via `conf.orm`) instead of the directory services. `models/user_ldap.js` and `utils/access.js` become conditional facades that pick their backend at require time — `ssh_server.js`, `bridge.js`, `key_inject.js`, `tui_picker.js`, and the web UI are unchanged either way.
- New ORM models: `StandaloneUser` (`uid`, `passwordHash`, `sshPublicKeys`, `groups`) and `StandaloneHost` (`slug`, `displayName`, `kind`, `metadata`), plus `models/user_file.js` and `utils/hosts_file.js`, which implement the same interfaces as the LDAP client and `accessibleHosts()` respectively. There's no admin UI for standalone users/hosts yet — see the README's "Standalone mode" section for the ORM-model seeding snippet. In standalone mode every stored host is reachable by every stored user; there's no group-based authorization yet.
- 47 tests pass (24 existing + 15 new unit + 3 existing integration + 5 new standalone integration).

### Fixed
- **`services/ssh_server.js` used `|| 2222` for the listen port**, so an explicit `listenPort: 0` (ephemeral port, used by the test suite) was silently overridden back to 2222. Changed to `?? 2222`.
- **`services/ssh_server.js` awaited `audit.create()` before registering session listeners.** A client that sends `exec`/`shell` immediately after connecting could have its request dropped because nothing was listening yet. Listener registration now happens first.

## [1.3.0] - 2026-07-26

### Changed
- **Unified the front-end UI shell across the three theta42 apps.** `views/top.ejs`, `views/bottom.ejs` and `public/lib/js/app-base.js` are now byte-identical in sso-manager-node, proxy and jump-host, so the apps look and behave the same and a shell change lands in one edit per repo instead of three divergent ones. Everything that differs between the apps moved into a new `nodejs/utils/ui.js`, exposed to every render as `ui` via `app.locals`: nav items and the groups that may see them, footer repo/license/docs/Terms links, favicon, the profile and post-logout targets, and whether the update banner exists at all.
- **One nav-gating model everywhere.** `app-base.js` reveals `.group-required-<cn>` elements for each group the current user is in, read from `GET /api/user/me`. sso-manager-node reports LDAP DNs in `memberOf` and the OIDC clients report CNs in `groups`; both normalise to CNs client-side, and the clients' effective-rights `isAdmin` flag is exposed as a synthetic `admin` group — so one gating model covers a group-based provider and boolean-admin clients without either app learning the other's response shape.
- **`GET /api/user/me` is fetched once per page load and cached** (`app.auth.loadUser`). The nav, per-view `forceLogin` and every group-gated element read that one promise instead of issuing their own request.
- `app.auth.isLoggedIn` is dual-mode: it returns a Promise **and** invokes an optional node-style callback, so the async and callback call styles both work against one shared `top.ejs`.
- `app.auth.forceLogin` no longer uses `$.holdReady` (removed in jQuery 4). An unauthenticated user is redirected to `/login?redirect=<path>`; group requirements are still enforced, and `logOut` now only clears the session, leaving the destination to the caller (`ui.logoutRedirect`).
- Dependency alignment across all three apps: `jquery` `^4.0.0` and `ejs` `^3.1.10`.

### Fixed
- **`app.api.delete` dropped its callback when called by `formAJAX`.** `formAJAX` always passes the serialized form as the second argument, so a DELETE-method form's callback landed in the data slot and never ran. `delete` now accepts both `(url, callback)` and `(url, data, callback)`.
- **`app.api.post`/`put` referenced an undefined `callback2`** and threw when handed a non-function callback. Both are now dual-mode Promise/callback.
- **The login page's "reveal the card once we know you're logged out" branch threw** (`Cannot read properties of null`) whenever the logged-in check answered before the parser reached that element — which it always did without a stored token. It now runs on DOM ready.
- **`logInRedirect` on the legacy `/login/<path>` form kept only the path.** The OIDC provider routes an unauthenticated authorization request through `/login/oauth/authorize?client_id=…&state=…`; dropping the query there loses the entire authorization request. The suffix form now preserves its query string.

### Added
- `.group-required { display: none }` in `public/css/styles.css`, the base rule the shared gating model reveals against.
- `#spa-shell` dropped its inline `margin-top`; `styles.css` already sets it and the shared shell adjusts it when a banner is shown.

### Verified
- Browser-verified against a full theta-env stack (sso-manager + proxy + jump-host): every top-level page renders with a clean console; nav gating is correct for admin and non-admin; `forceLogin`'s onboarding and group gates fire; `val.js` blocks a weak password and accepts a strong one through a real form submit; the DELETE-method forms work; and the OIDC login round trip (authorize with PKCE -> login -> consent -> callback -> token fragment) completes on both OIDC clients.

## [1.2.0] - 2026-07-25

### Added
- Adopted the shared `@simpleworkjs/*` packages published under the simpleworkjs org, replacing this app's byte-identical forks of the same code so the theta42 apps share one codebase and API schema:
  - `@simpleworkjs/oidc-client` — the OIDC client (session models, auth router, OIDC utils, safe-redirect, local-admin bootstrap). Deleted the local `utils/oidc.js`, `utils/safe_redirect.js`, `models/oidc_state.js`, `models/token.js`, `models/auth.js`, `routes/auth.js`; `models/index.js` wires the factory and the local-admin bootstrap.
  - `@simpleworkjs/directory-schema` — the sso↔jump-host directory contract. `utils/access.js` now fetches reachable hosts through the shared `createDirectoryClient` (`getResourcesByGroup`).
  - `@simpleworkjs/ldap` — `models/user_ldap.js` is now a thin wrapper over `createLdapClient`, preserving this app's loose TLS default (`rejectUnauthorized: false`) and the exact export shape.
  - `@simpleworkjs/app-stack` — unified `build_info` (`{buildVersion, buildHash, buildYear}`) and the `static-modules` mounting helper. `build_info` moved from `models/` to `utils/`; `routes/render.js` uses `mountStaticModules`.

### Fixed
- **Directory envelope drift was silently treated as "no reachable hosts".** `utils/access.js` previously read `data.results || []`, so if the SSO directory ever returned a bare array (envelope drift) every per-group query collapsed to `[]` and no user could bridge. The shared client now validates the `{ results }` envelope on every call and treats an envelope violation as a failed group fetch rather than silently returning `[]`.

### Changed
- Dependency alignment: `ldapts` `^8.1.2` → `^8.1.8`, `redis` `^4.7` → `^6.1.0` (the direct `redis` dep is unused — only `model-redis` is used, which already brings `redis` ^6.1.0). The new `@simpleworkjs/*` deps resolve from the npm registry (`^1.0.0`); no `file:`/`link:` entries in the lockfile, so `npm ci` is clean in docker builds.
- `build_info` export shape changed from `{commit, version}` to `{buildVersion, buildHash, buildYear}` (the shared shape used by all three apps). The `/health` endpoint and footer now report `buildVersion`/`buildHash`.

## [1.1.0] - 2026-07-23

### Changed
- **Rebuilt the web UI on the shared theta42 app stack** so it looks and behaves like the SSO Manager and Proxy: Express + EJS with the same `top.ejs`/`bottom.ejs` shell, Bootstrap 5, jQuery, jq-repeat, FontAwesome, the shared `app-base.js` client framework, and Socket.IO — replacing the bespoke minimal theme. Dashboard, Sessions, and Audit pages now render in the common look/feel.
- **Web-UI auth is now OIDC + a local anti-lockout admin** (the proxy's model), replacing the direct LDAP-bind login. Normal users log in through the SSO ("Log in with SSO"); a local `auth.adminUsers` account (bootstrapped on first boot, password from `auth.localAdminPass`) still works if the SSO is unreachable. Admin access is gated by `auth.adminGroups` or the local admin account. New config: `oidc` block + `auth.adminUsers`/`localAdminPass`. **Note:** the SSH bridge and its own LDAP auth are unchanged — this only affects the web management UI.

## [1.0.1] - 2026-07-23

### Fixed
- Test scripts use shell-expanded globs and CI provides a redis service, so `npm test` runs green on the Node 20/22 CI runners (the `node --test` `**` glob and the redis-backed models only worked locally before). No runtime change.

## [1.0.0] - 2026-07-23

### Added
- Initial release. An SSH jump host for the theta42 stack:
  - **Username-grammar routing**: `ssh {uid}_-_{target}@jumphost` bridges
    straight to the downstream host (`target` = a directory host slug, bare
    hostname, or IP). Shell, exec, and the **SFTP subsystem** all pass through,
    so WinSCP/`sftp` work.
  - **Interactive TUI picker**: plain `ssh {uid}@jumphost` lists the hosts the
    user can reach (from the SSO directory) and bridges to the chosen one.
  - **LDAP auth** of the inbound user (publickey against the user's
    `sshPublicKey`, or password via LDAP bind — password policy is
    off/local/all).
  - **Directory-driven access**: reachable hosts are the union of the user's
    LDAP groups × the SSO directory (`/api/discovery/resources?group=`).
  - **Per-user key injection**: the jump host appends its own public key to the
    user's `sshPublicKey` on first use, then connects downstream as that user
    (downstream hosts already serve LDAP keys via ldap-client's
    AuthorizedKeysCommand).
  - **Web UI + HTTP API** (`:3002`) for auditing and metrics: active sessions,
    paged audit log, per-user/per-host counters. Admin login gated by LDAP
    group membership.
  - **Audit logging** of every connection attempt/session (user, target,
    method, result, bytes, duration, downstream host-key fingerprint).
  - Packaged like theta42/proxy: idempotent `ops/install.sh` + systemd unit,
    all-in-one Docker image, standalone `docker-compose.yml`.
