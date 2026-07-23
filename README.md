# Theta42 Jump Host

An SSH jump host for the [theta42](https://github.com/theta42) self-hosted
stack. Users SSH into one public host and land on any downstream host they're
entitled to — authenticated against the shared LDAP directory, authorized from
the [SSO Manager](https://github.com/theta42/sso-manager-node)'s inventory
graph, audited end to end.

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

## Requirements

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

`https://jump.example.com/` (behind the proxy) — admin login uses your LDAP
credentials and requires membership in `auth.adminGroups` (default
`app_sso_admin`).

- `GET /health` — open; `{status, activeSessions, version}`
- `GET /api/sessions` — active sessions
- `GET /api/audit?page=&uid=&target=&status=` — paged audit log
- `GET /api/metrics` — counters (total, failures, top users/hosts)

## Configuration

Config layers via [@simpleworkjs/conf](https://www.npmjs.com/package/@simpleworkjs/conf):
`conf/base.js` < `conf/<NODE_ENV>.js` < the `CONF_SECRETS` file < `app_*` env.
See `secrets.js.example` for every key.

## Development

```
cd nodejs && npm install
npm test          # unit + integration (node --test)
NODE_ENV=development npm run dev
```

## License

MIT
