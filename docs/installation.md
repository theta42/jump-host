---
layout: default
title: Installation
description: Install the gateway on the host — bundled in the theta-suite stack or direct install.sh — plus standalone mode (no LDAP/SSO), the LDAP write-ACL, and port-22 options.
---

# Installation

The gateway installs on the **host**, not in a container (it is a router).
All paths read their config through
[@simpleworkjs/conf](https://www.npmjs.com/package/@simpleworkjs/conf)
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

The rest of this page (requirements, the LDAP write-ACL, the install paths)
describes the default LDAP + SSO mode — skip it if you're running standalone.

## Requirements

- The [SSO Manager](https://theta42.github.io/sso-manager-node/) (OpenLDAP
  directory + `/api/discovery`), v1.3.0 or newer.
- Downstream hosts joined via
  [ldap-client](https://github.com/theta42/ldap-client) (SSSD +
  `AuthorizedKeysCommand`).
- An LDAP bind account with **write access to the `sshPublicKey` attribute** on
  user entries (see below).
- An SSO API token (`sso_…`) for the directory queries.

## 1. Unified theta-suite stack (recommended)

`theta-suite`'s `setup.sh` installs and configures the gateway for you. Set in
`setup.env`:

```bash
CFG_JUMP_HOST=jump.example.com
JUMP_SSH_PORT=2222
```

Re-run `./setup.sh`. It writes `./config/jump-secrets.js`, mints the directory
API token, grants the `sshPublicKey` write-ACL, copies the secrets file to
`/etc/theta-gateway/jump-secrets.js`, runs `jump-host/install.sh` (systemd
`theta-gateway.service`), registers the web UI hostname in the proxy, and seeds
a directory entry.

## 2. Direct install

```bash
sudo ./install.sh                    # install or upgrade in place (idempotent)
sudo ./install.sh --uninstall        # remove the service (keeps config + data)
```

`install.sh` installs dependencies (Redis, iproute2, iptables, wireguard-tools)
and Node >= 20.14, lays the app down at `/opt/theta-gateway`, writes
`/etc/theta-gateway/gateway.env` (created once, never clobbered on upgrade),
installs a systemd drop-in so `redis-server` runs the loopback-bound
`/etc/redis/theta-gateway.conf` (data at `/var/lib/theta-gateway/redis`), and
enables the unit. The SSH-port conflict check fails loudly up front rather
than "succeeding" and leaving you locked out.

For the full stack you also need `/etc/theta-gateway/jump-secrets.js` (LDAP
bind + SSO token + OIDC client) — `setup.sh` writes it, or seed it from
`secrets.js.example`.

## 3. Standalone Docker

For development only (the gateway cannot route from inside a container):

```bash
cp secrets.js.example config/jump-secrets.js
$EDITOR config/jump-secrets.js        # LDAP bind (+ sshPublicKey write ACL), SSO url + token
docker compose up -d --build
```

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
22, set `JUMP_SSH_PORT=22` in `/etc/theta-gateway/gateway.env` and either:

- **systemd:** add `AmbientCapabilities=CAP_NET_BIND_SERVICE` to the unit; or
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

Watch `journalctl -u theta-gateway -f` and the audit log at `/audit` in the web
UI.
