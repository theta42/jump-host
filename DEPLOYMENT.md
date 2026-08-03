# Deployment

Three ways to run the jump host, in increasing manual effort.

## 1. Unified theta-env stack

Set in `theta-env/setup.env`:

```
CFG_JUMP_HOST_ENABLED=true
CFG_JUMP_HOST=jump.example.com
JUMP_SSH_PORT=2222
```

Re-run `./setup.sh`. It builds the submodule, writes `config/jump-secrets.js`,
mints the SSO API token, grants the `sshPublicKey` write-ACL to the shared
`cn=ldapclient` bind account, registers `jump.example.com` in the proxy, and
seeds a directory entry.

Expose SSH: forward the public host's `:22` (or `:2222`) to the container's
published `JUMP_SSH_PORT`.

## 2. Standalone Docker

```
cp secrets.js.example config/jump-secrets.js
$EDITOR config/jump-secrets.js        # LDAP bind (+ sshPublicKey write ACL), SSO url + token
docker compose up -d --build
```

Host keys persist in the `jump-data` volume. The web UI is on `:3002`; front it
with your own TLS/proxy.

## 3. Bare metal

```
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

The bind account must be able to write the `sshPublicKey` attribute so the jump
host can inject its key. In the bundled OpenLDAP (`slapd.conf` / `olc`):

```
access to attrs=sshPublicKey
    by dn.exact="cn=ldapclient,ou=people,dc=example,dc=com" write
    by self write
    by * read
```

Without it, key injection fails and every bridge attempt is audited
`key-inject-failed`.

## Listening on port 22

Default is 2222 (unprivileged). For 22: set `ssh.listenPort: 22`, and either

- systemd: uncomment `AmbientCapabilities=CAP_NET_BIND_SERVICE` in the unit; or
- Docker: publish `22:22`; or
- firewall: DNAT `22 → 2222`.

## Verifying

```
# from a client whose key is in your LDAP sshPublicKey
ssh -p 2222 youruid@jump.example.com          # TUI picker
ssh -p 2222 youruid_-_somehost@jump.example.com
sftp -P 2222 youruid_-_somehost@jump.example.com

curl -s http://localhost:3002/health
```

Watch `journalctl -u jump-host -f` (or `docker logs -f jump-host`) and the
audit log at `/audit` in the web UI.
