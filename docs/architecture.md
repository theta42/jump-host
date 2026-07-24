---
layout: default
title: Architecture
description: How the jump host authenticates users, resolves reachable hosts from the directory, injects per-user keys, and bridges SSH — plus the web UI and audit model.
---

# Architecture

The jump host is a Node.js service (using [`ssh2`](https://github.com/mscdex/ssh2)
as both an SSH **server** and **client**) with two faces: the SSH front door
(default `:2222`) and a web UI/API (`:3002`). It holds no user database of its
own — identity, authorization, and onward credentials all come from the shared
directory.

```
      ┌────────────────────── jump host ──────────────────────┐
 ssh  │  ssh2 Server (:2222)                                   │  ssh2 Client
 ─────┼─▶ 1. authenticate user  ──▶ LDAP (sshPublicKey / bind) │  ───────────▶  downstream
 user │  2. resolve target      ──▶ SSO /api/discovery         │                sshd (as the
      │  3. inject key          ──▶ LDAP (add sshPublicKey)    │                real user)
      │  4. bridge channels ◀───────────────────────────────▶ │
      │  web UI/API (:3002)  ──▶ audit + metrics (redis)       │
      └───────────────────────────────────────────────────────┘
```

## 1. Inbound authentication

When a user connects, the jump host authenticates them against LDAP:

- **Public key** — it looks up the user's `sshPublicKey` values in the directory
  and matches the offered key (handling ssh2's probe-then-sign two-phase
  publickey auth). The jump host's *own* injected key (identified by its comment
  marker) is deliberately excluded from this match — only the jump host may hold
  that private key, so accepting it inbound would be a bypass.
- **Password** — an LDAP simple bind as the user's DN. Policy is configurable:
  `off` (keys only — recommended for a public host), `local` (passwords only
  from loopback/RFC1918 clients, keys-only from the internet), or `all`.

Every attempt — success or failure, with method and reason — is audited.

## 2. Access & target resolution

The hosts a user may reach are computed from the directory, not a local list:

1. The user's LDAP group memberships (`(&(objectClass=groupOfNames)(member=…))`).
2. For each group, the SSO's
   `GET /api/discovery/resources?group=<cn>` (authenticated with an API token),
   unioned and filtered to `kind: host`.

Each host's dial address is `metadata.ip` (or the hostname from
`metadata.address`) and port `metadata.sshPort` (default 22). Results are cached
briefly per user and shared by both the grammar path and the TUI picker.

Target matching tries, in order: exact slug → `host_`-prefixed slug → display
name → IP → address hostname. A raw IP that isn't an accessible directory host
is refused unless explicitly allowed.

> The directory auto-creates `<slug>_access` / `<slug>_admin` groups for every
> host and service (see the SSO's
> [Directory & Inventory](https://theta42.github.io/sso-manager-node/directory.html)
> docs), which is exactly what this authorization reads.

## 3. Per-user key injection {#per-user-key-injection}

The jump host holds **one** keypair. To connect downstream *as the user*
without asking them for anything, it must present a key the downstream `sshd`
will accept for that user. Downstream hosts (joined via
[ldap-client](https://github.com/theta42/ldap-client)) serve authorized keys
straight from LDAP via `AuthorizedKeysCommand`. So on a user's first connection,
the jump host appends its own public key to that user's `sshPublicKey` attribute
in LDAP — comment-marked so it's recognizable — then connects downstream with
its private key.

- Idempotent: the key is added once; a redis flag skips the LDAP round-trip
  afterwards.
- The jump host's bind account therefore needs **write access to the
  `sshPublicKey` attribute** on user entries (an OpenLDAP ACL — see the README).
  In the bundled theta-env deployment this is handled for you.
- Because the marker key is excluded from inbound auth (step 1), it grants only
  the jump host's onward path, never inbound impersonation.

## 4. Bridging

Once the upstream connection is ready, the jump host splices SSH channels
between the two connections:

- **shell / exec** — piped both ways, with window-change and exit-status
  forwarded.
- **SFTP subsystem** — the two subsystem channels are raw-piped as opaque bytes;
  no SFTP protocol parsing is needed, which is why WinSCP and `sftp` work
  unchanged.
- Channel requests that arrive before the upstream is ready are buffered and
  replayed, so nothing is dropped during the connect.
- The downstream host key's SHA256 fingerprint is recorded in the audit event
  (trust-on-use in v1).

Byte counts per direction are tallied cheaply for the audit record.

## Web UI, API & audit

An Express + EJS + Bootstrap app on `:3002` — the same front-end stack and
look/feel as the SSO Manager and Proxy. Login is OIDC against the SSO plus a
local anti-lockout admin (`auth.adminUsers`), with admin access gated by
`auth.adminGroups`. It exposes:

- `GET /health` — open; `{status, activeSessions, version}`
- `GET /api/sessions` — active sessions
- `GET /api/audit?page=&uid=&target=&status=` — the paged audit log
- `GET /api/metrics` — counters (total, failures, top users/hosts)

Audit events and counters live in redis. Each event captures: user, auth method,
mode (grammar/picker), target slug/address/port, channel type, client IP,
success + failure reason, downstream host-key fingerprint, timing, and bytes in/out.

## Where it sits in the stack

- **[SSO Manager](https://theta42.github.io/sso-manager-node/)** — provides the
  OpenLDAP directory (users, groups, `sshPublicKey`) and the inventory API this
  jump host reads.
- **[ldap-client](https://github.com/theta42/ldap-client)** — enrolls the
  downstream Linux hosts (SSSD/PAM + `AuthorizedKeysCommand`) that the jump host
  connects into.
- **[Proxy](https://theta42.github.io/proxy/)** — fronts the jump host's web UI
  under TLS.
- **[theta-env](https://theta42.github.io/theta-env/)** — wires it all together.
