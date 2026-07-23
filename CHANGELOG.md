# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
correspond to git tags (`vX.Y.Z`) and `nodejs/package.json`'s `version`.

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
