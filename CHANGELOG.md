# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
correspond to git tags (`vX.Y.Z`) and `nodejs/package.json`'s `version`.

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
