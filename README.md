# Theta Gateway

An SSH jump gateway and integrated WireGuard mesh network router for the [Theta Suite](https://github.com/theta42/theta-suite) ecosystem. Users SSH into one entry point (`:2222`) and reach target downstream hosts according to directory permissions, with full auditing end-to-end.

Theta Gateway authenticates users against the shared OpenLDAP directory, authorizes access using **Theta Directory** (`theta-directory`), and routes cross-site mesh traffic with native WireGuard subnets and NETMAP shadow network support.

**Documentation:** [https://theta42.github.io/theta-suite/jump-host/](https://theta42.github.io/theta-suite/jump-host/)

## Access Flow

**Direct (WinSCP/SFTP-friendly):**

```bash
ssh alice_-_web01@jump.example.com          # -> target host slug 'web01'
sftp -P 2222 alice_-_web01@jump.example.com # SFTP passes through unchanged
```

The username grammar is `{uid}_-_{target}`. `target` is a directory host slug or hostname.

**Interactive host picker:**

```bash
ssh alice@jump.example.com
```

Plain login displays a TUI list of target hosts assigned to the local site (`SITE_SLUG`) that the user is authorized to reach.

## How it Works

1. **Inbound Auth** — OpenLDAP authentication via public key matching (`sshPublicKey`) or LDAP password bind.
2. **Authorization** — Calls Theta Directory's access API (`GET /api/discovery/access/:uid`) to evaluate LDAP group memberships and site-filtered host entitlement.
3. **Key Injection** — Appends its gateway public key to user `sshPublicKey` in LDAP and connects downstream as the user.
4. **Bridge & Audit** — Slices shell/SFTP subsystem to downstream sshd with session audit logging.

## Deployment

Theta Gateway is deployed exclusively via Docker Compose as an integrated service within **Theta Suite** — it is not installed or run on its own:

```bash
git clone --recursive https://github.com/theta42/theta-suite.git
cd theta-suite
cp setup.env.example setup.env   # set CFG_DOMAIN to your domain
./setup.sh                       # generates config, builds, and starts Theta Suite
```

Enable it via `CFG_JUMP_HOST_ENABLED=true` in `setup.env` and re-run
`./setup.sh`. The stack wires the LDAP bind account (write access to the
`sshPublicKey` attribute), the write-ACL, the SSO API token, and a directory
entry automatically.

See the main [Theta Suite README](https://github.com/theta42/theta-suite) for full details on multi-site configuration, WireGuard mesh routing, and network setup.

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
Express + EJS + Bootstrap stack as [Theta Directory](https://theta42.github.io/theta-suite/sso/)
and [Theta Proxy](https://theta42.github.io/theta-suite/proxy/), so it looks and behaves like the
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
theta-suite's **[Secrets docs](https://theta42.github.io/theta-suite/secrets.html)**.

## Development

```
cd nodejs && npm install
npm test          # unit + integration (node --test)
NODE_ENV=development npm run dev
```

## License

MIT
