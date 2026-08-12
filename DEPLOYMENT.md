# Deployment

## 1. Theta Gateway on this host (the supported path)

The gateway is the one Theta Suite component that does NOT run in a container,
because it is a router: NETMAP of the physical LAN, MASQUERADE out the real
uplink, host-namespace `net.*` sysctls, and being the next hop for the LAN's
`10.0.0.0/8` route are all things a Docker network namespace cannot do.

```
sudo ./install.sh                    # install or upgrade in place (idempotent)
sudo ./install.sh --uninstall        # stop + remove the service (keeps config/data)
```

`install.sh`:

- installs dependencies (Redis, iproute2, iptables, wireguard-tools, procps)
  and Node >= 20.14 from NodeSource if missing;
- lays the application down at `/opt/theta-gateway`, config at
  `/etc/theta-gateway/` (`gateway.env`), and data at `/var/lib/theta-gateway/`
  (including the Redis dir that holds the WireGuard identity — see "Identity
  and data" below);
- writes a loopback-bound Redis config at `/etc/redis/theta-gateway.conf` and
  installs a systemd drop-in so `redis-server` actually loads it;
- installs the `theta-gateway` systemd unit and starts it.

In the unified stack, `theta-suite`'s `setup.sh` runs this for you after
copying `./config/jump-secrets.js` to `/etc/theta-gateway/jump-secrets.js`.
Set `CFG_JUMP_HOST=jump.example.com`, `JUMP_SSH_PORT=2222` in `setup.env` and
re-run `./setup.sh`.

## 2. Where the config lives

```
/etc/theta-gateway/gateway.env      # env the systemd unit loads (edit freely)
/etc/theta-gateway/jump-secrets.js  # LDAP bind, SSO API token, OIDC client
/var/lib/theta-gateway/             # host keys, Redis data (AOF)
```

`gateway.env` is written once on first install and left alone on upgrades, so
operator edits survive. `jump-secrets.js` is written by `setup.sh`'s bootstrap.

## Identity and data

The gateway's WireGuard identity and SSH host keys must survive restarts —
every peer in the cluster holds the public halves. `--uninstall` deliberately
keeps `/etc/theta-gateway` and `/var/lib/theta-gateway`; delete them only if
this site is gone for good.

## The LDAP write-ACL (required)

The bind account must be able to write the `sshPublicKey` attribute so the
gateway can inject its key. In the bundled OpenLDAP (`slapd.conf` / `olc`):

```
access to attrs=sshPublicKey
    by dn.exact="cn=ldapclient,ou=people,dc=example,dc=com" write
    by self write
    by * read
```

Without it, key injection fails and every bridge attempt is audited
`key-inject-failed`.

## Listening on port 22

Default is 2222 (unprivileged). For 22: set `JUMP_SSH_PORT=22` in
`gateway.env`, and either

- systemd: add `AmbientCapabilities=CAP_NET_BIND_SERVICE` to the unit; or
- firewall: DNAT `22 → 2222`.

## WireGuard mesh

The gateway is roster-driven: the directory allocates each site its siteId and
holds what every gateway published (`PUT /api/mesh/self`); the gateway pulls
the roster and converges its own `wg`/`ip`/`iptables`. Open UDP 51820 (or
`THETA_MESH_ENDPOINT`'s port) in the host firewall — a fresh `ufw` will block
the mesh silently otherwise.

## Verifying

```
# from a client whose key is in your LDAP sshPublicKey
ssh -p 2222 youruid@jump.example.com          # TUI picker
ssh -p 2222 youruid_-_somehost@jump.example.com
sftp -P 2222 youruid_-_somehost@jump.example.com

curl -s http://localhost:3002/health
```

Watch `journalctl -u theta-gateway -f` and the audit log at `/audit` in the
web UI.
