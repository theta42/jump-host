# Theta42 Jump Host

An SSH jump host for the [theta42](https://github.com/theta42) self-hosted
stack. Users SSH into one public host and land on any downstream host they're
entitled to — audited end to end.

Two backends, same SSH front door and audit trail: the default mode
authenticates against the shared LDAP directory and authorizes from the
[SSO Manager](https://github.com/theta42/sso-manager-node)'s inventory graph;
**standalone mode** (below) runs with no LDAP or SSO at all, storing users and
hosts in a local SQL database instead.

## Two ways to connect

**Direct (WinSCP/SFTP-friendly):**

```
ssh alice_-_web01@jump.example.com          # -> host slug 'web01' / 'host_web01'
sftp -P 2222 alice_-_web01@jump.example.com # SFTP passes through unchanged
```

The username grammar is `{uid}_-_{target}`. `target` is a directory host slug
(with or without the `host_` prefix), a bare hostname, or an IP.

**Interactive picker:**

```
ssh alice@jump.example.com
```

Plain login shows a TUI list of the hosts you can reach; pick one and you're
bridged straight in.

## How it works

1. **Inbound auth** — LDAP. Public key (matched against your `sshPublicKey`, the
   jump host's own injected key excluded) or password (LDAP bind; the
   `ssh.passwordAuth` policy can restrict passwords to local clients or disable
   them — keys-only is recommended for a public host).
2. **Authorization** — the hosts you may reach are the union of your LDAP groups
   × the SSO directory (`/api/discovery/resources?group=<cn>`). No directory
   entry, no access.
3. **Key injection** — on first use the jump host appends its own public key to
   your `sshPublicKey` in LDAP (comment-marked), then connects downstream **as
   you** using its private key. Downstream hosts already serve keys from LDAP
   via [ldap-client](https://github.com/theta42/ldap-client)'s
   `AuthorizedKeysCommand`, so nothing downstream needs changing.
4. **Bridge** — shell, exec, and the SFTP subsystem are spliced to the
   downstream sshd. Every session is audited.

## Standalone mode

Run without LDAP or the SSO Manager at all. Set `standalone.enabled: true` and
the jump host stores users and hosts itself, via
[@simpleworkjs/orm](https://www.npmjs.com/package/@simpleworkjs/orm)
(Sequelize under the hood — defaults to a local SQLite file, but any
Sequelize-supported dialect works via `conf.orm`):

```js
standalone: { enabled: true },
orm: { dialect: 'sqlite', storage: './data/standalone.sqlite', logging: false },
```

Everything else — the SSH front door, key injection, bridging, the web UI and
audit trail — is unchanged; only where users/hosts live and how passwords are
checked differs. There's no admin UI for standalone users/hosts yet — add them
with the ORM models directly:

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

In standalone mode every stored host is reachable by every stored user — there
is no group-based authorization (the `groups` field on `StandaloneUser` is
accepted for interface parity but not yet enforced).

## Requirements

*(default LDAP + SSO mode — see [Standalone mode](#standalone-mode) to skip
all of this)*

- The SSO Manager (OpenLDAP directory + `/api/discovery`).
- Downstream hosts joined via ldap-client (SSSD + `AuthorizedKeysCommand`).
- An LDAP bind account with **write access to the `sshPublicKey` attribute** on
  user entries (see the ACL note in `secrets.js.example`).
- An SSO API token (`sso_…`) for the directory queries.

## Install

### Unified theta-env stack (recommended)

Enable it in `theta-env/setup.env` (`CFG_JUMP_HOST_ENABLED=true`) and re-run
`./setup.sh`. The stack wires the LDAP bind account, the write-ACL, the API
token, and a directory entry automatically.

### Standalone Docker

```
cp secrets.js.example config/jump-secrets.js   # then edit it
docker compose up -d --build
```

### Bare metal

```
curl -fsSL https://raw.githubusercontent.com/theta42/jump-host/master/ops/install.sh | sudo bash
sudo $EDITOR /etc/jump-host/secrets.js         # fill in LDAP + SSO
sudo systemctl restart jump-host
```

Installs to `/opt/theta42/jump-host`; idempotent (re-run to update).

## Ports

| Port | Purpose |
|------|---------|
| 2222 | SSH front door (default; see below for :22) |
| 3002 | Web UI + HTTP API (audit, metrics) |

The default SSH port is **2222** so the service needs no privilege. To listen on
22, set `ssh.listenPort: 22` in your secrets and either uncomment
`AmbientCapabilities=CAP_NET_BIND_SERVICE` in the systemd unit, or DNAT
22 → 2222 at the firewall.

## Web UI / API

`https://jump.example.com/` (behind the proxy) — built on the same
Express + EJS + Bootstrap stack as the [SSO Manager](https://theta42.github.io/sso-manager-node/)
and [Proxy](https://theta42.github.io/proxy/), so it looks and behaves like the
rest of the stack. Login is **OIDC against the SSO** (the "Log in with SSO"
button) plus a **local anti-lockout admin** that works even if the SSO is
unreachable. Admin access requires membership in `auth.adminGroups` (default
`app_sso_admin`) or being the local `auth.adminUsers` account.

- `GET /health` — open; `{status, activeSessions, version}`
- `GET /api/sessions` — active sessions
- `GET /api/audit?page=&uid=&target=&status=` — paged audit log
- `GET /api/metrics` — counters (total, failures, top users/hosts)

## Configuration

Config layers via [@simpleworkjs/conf](https://www.npmjs.com/package/@simpleworkjs/conf):
`conf/base.js` < `conf/<NODE_ENV>.js` < the `CONF_SECRETS` file < `app_*` env.
See `secrets.js.example` for every key.

## Secrets

At boot, [@simpleworkjs/bao-conf](https://simpleworkjs.github.io/bao-conf/)
deep-merges `secret/jump-host/conf` from **OpenBao** over the file-loaded
config. The jump host's OIDC `clientSecret` is captured at require time
(inside `createOidcClient` during `require('../models')`), so `bin/www` runs
`bao-conf.init()` **before** `require('../models')`. Fail-soft: if OpenBao is
unreachable, boot continues from `CONF_SECRETS`. The jump host authenticates to
OpenBao with the scoped `VAULT_TOKEN` (env, policy `jump-host` — read only
`secret/jump-host/conf`), never the root token.

The `config/jump-secrets.js` file is an operator-edit seed artifact
(gitignored); the bootstrap writes the generated API token + OAuth client
into OpenBao, which is authoritative. For the full architecture see
theta-env's **[Secrets docs](https://theta42.github.io/theta-env/secrets/)**.

## Development

```
cd nodejs && npm install
npm test          # unit + integration (node --test)
NODE_ENV=development npm run dev
```

## License

MIT
