---
layout: default
title: Installation
description: Install the jump host three ways — bundled in the theta-env stack, standalone Docker, or bare metal — plus standalone mode (no LDAP/SSO), the LDAP write-ACL, and port-22 options.
---

# Installation

Three ways to run the jump host, in increasing manual effort. All read their
config through [@simpleworkjs/conf](https://www.npmjs.com/package/@simpleworkjs/conf)
(`conf/base.js` < `conf/<NODE_ENV>.js` < the `CONF_SECRETS` file < `app_*` env).

## Standalone mode (no LDAP/SSO) {#standalone-mode}

Skip LDAP and the SSO Manager entirely. Not to be confused with "Standalone
Docker" below, which is still LDAP + SSO, just run outside theta-env. Set in your secrets/config:

```js
standalone: { enabled: true },
orm: { dialect: 'sqlite', storage: './data/standalone.sqlite', logging: false },
```

`orm` is passed straight to Sequelize, so any supported dialect works — SQLite
is just the zero-dependency default. Everything downstream of auth (bridging,
key injection, the web UI, audit) is unchanged.

There's no admin UI for standalone users/hosts yet, so add them directly with
the ORM models:

```js
const StandaloneUser = require('./models/standalone_user');
const StandaloneHost = require('./models/standalone_host');
const bcrypt = require('bcrypt');

await StandaloneUser.create({
  uid: 'alice',
  passwordHash: await bcrypt.hash('a real password', 10),
  sshPublicKeys: ['ssh-ed25519 AAAA... alice@laptop'],
  groups: [],
});

await StandaloneHost.create({
  slug: 'host_web01',
  displayName: 'web01',
  kind: 'host',
  metadata: { ip: '10.0.0.5', sshPort: 22 },
});
```

Every host in the standalone inventory is reachable by every standalone user —
there's no group-based authorization yet (`groups` on `StandaloneUser` is
accepted for interface parity with the LDAP path, not enforced).

The rest of this page (requirements, the LDAP write-ACL, the three install
paths) describes the default LDAP + SSO mode — skip it if you're running
standalone.

## Requirements

- The [SSO Manager](https://theta42.github.io/sso-manager-node/) (OpenLDAP
  directory + `/api/discovery`), v1.3.0 or newer.
- Downstream hosts joined via
  [ldap-client](https://github.com/theta42/ldap-client) (SSSD +
  `AuthorizedKeysCommand`).
- An LDAP bind account with **write access to the `sshPublicKey` attribute** on
  user entries (see below).
- An SSO API token (`sso_…`) for the directory queries.

## 1. Unified theta-env stack (recommended)

Enable it in `theta-env/setup.env`:

```bash
CFG_JUMP_HOST_ENABLED=true
CFG_JUMP_HOST=jump.example.com
JUMP_SSH_PORT=2222
```

Re-run `./setup.sh`. The stack builds the submodule (behind the `jump-host`
compose profile), mints the directory API token, writes
`./config/jump-secrets.js`, grants the `sshPublicKey` write-ACL, registers the
jump host in the proxy, and seeds a directory entry. Forward the public host's
`:22` (or `:2222`) to the container's published `JUMP_SSH_PORT`.

## 2. Standalone Docker

```bash
cp secrets.js.example config/jump-secrets.js
$EDITOR config/jump-secrets.js        # LDAP bind (+ sshPublicKey write ACL), SSO url + token
docker compose up -d --build
```

Host keys persist in the `jump-data` volume. The web UI is on `:3002`; front it
with your own TLS/proxy.

## 3. Bare metal

```bash
curl -fsSL https://raw.githubusercontent.com/theta42/jump-host/master/ops/install.sh | sudo bash
sudo $EDITOR /etc/jump-host/secrets.js
sudo systemctl restart jump-host
journalctl -u jump-host -f
```

`ops/install.sh` installs Node 22 + Redis, hard-resets the checkout at
`/opt/theta42/jump-host` to the remote branch, symlinks the systemd unit, and
runs `npm ci`. Idempotent — re-run to update. Overridable via `REPO_DIR=`,
`BRANCH=`, `SECRETS_FILE=`.

## The LDAP write-ACL (required)

The jump host injects its public key into each user's `sshPublicKey`, so its
bind account must be able to **write** that attribute. In the bundled OpenLDAP:

```
access to attrs=sshPublicKey
    by dn.exact="cn=ldapclient,ou=people,dc=example,dc=com" write
    by self write
    by * read
```

In the theta-env bundle this is handled for you (the jump host binds as the LDAP
admin). For a hardened standalone deployment, use a dedicated bind account with
exactly this attribute-scoped ACL. Without write access, key injection fails and
every bridge attempt is audited `key-inject-failed`.

## Listening on port 22

The default SSH port is **2222** so the service needs no privilege. To listen on
22, set `ssh.listenPort: 22` and either:

- **systemd:** uncomment `AmbientCapabilities=CAP_NET_BIND_SERVICE` in the unit;
- **Docker:** publish `22:22`; or
- **firewall:** DNAT `22 → 2222`.

## Configuration reference

Every key is documented in
[`secrets.js.example`](https://github.com/theta42/jump-host/blob/master/secrets.js.example):
`ldap` (bind + bases + TLS), `sso` (url + apiToken), `ssh`
(`listenPort`, `passwordAuth`, `allowRawIPs`, `keyComment`, timeouts,
`maxSessions`), `web.port`, `oidc` (web-UI SSO login), `auth`
(`adminGroups` / `adminUsers` / `localAdminPass`), and `redis`.

## Verifying

```bash
ssh -p 2222 youruid@jump.example.com               # TUI picker
ssh -p 2222 youruid_-_somehost@jump.example.com    # direct
sftp -P 2222 youruid_-_somehost@jump.example.com   # WinSCP path
curl -s http://localhost:3002/health
```

Watch `journalctl -u jump-host -f` (or `docker logs -f jump-host`) and the audit
log at `/audit` in the web UI.
