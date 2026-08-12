## v3.2.0

- feat: **notifications, with history and a bell.** This app pushed nothing over
  its socket before — it was attached only so the shared front-end kept working.
  Everything here arrives *with* its read gate rather than after one, which is
  the ordering the sibling apps had to be retrofitted into.
- feat: **the SSH audit trail is the event stream.** Who connected to which
  host, announced on the attempt and again when the session ends and its
  success and byte counts are known. Gated to jump admins, matching the audit
  API.
- feat: `ApiToken` announces create and remove only — its best-effort
  `last_used_on` write happens on every authenticated API call, and announcing
  that would put an event on the socket per request. Owner-scoped with no admin
  bypass: a personal access token is nobody else's business, and the REST route
  agrees.
- feat: an in-process pub/sub bus (`controller/pubsub`). The sibling apps use
  p2psub to gossip between processes; this is one process, so it is an
  EventEmitter with the same API surface — and it matches against the RegExp
  itself rather than stringifying and rebuilding it, which is the bug that
  silently killed every regex subscription in `@simpleworkjs/backend`.
- feat: `authIO` carries the session's groups and admin flag, which the
  jump-admin gate resolves from.
- chore: the notification client comes from `@simpleworkjs/frontend` 0.4.0;
  this app supplies only its link map.

## v3.1.6

- chore: picks up `@simpleworkjs/frontend` 0.3.1 (filtered rows carrying a
  Bootstrap display utility are actually hidden; the filter count no longer goes
  stale). No view here uses the filter layer yet, so this is a dependency
  alignment rather than a behaviour change.

## v3.1.5
- feat: the shared UI shell loads `app.sync.js` and `app.filter.js` from `@simpleworkjs/frontend`, so views here can adopt the same live-update and filtering layers as the other apps.
- chore: removed the client-side publish forwarding from `app-base.js`. It echoed every local publish back over the socket for the server to fan out. This app attaches socket.io only to serve the client library, so unlike proxy and theta-directory there was no bridge to secure — but the code was dead weight, and its twin in the other two apps was a topic-injection path.
- fix: a delete event carries a `null` body, and the client tagged it unconditionally — throwing and killing the socket handler.

## v3.1.4

- fix: **the loopback Redis config is actually loaded now.** `install.sh` wrote
  `/etc/redis/theta-gateway.conf` (loopback bind, `dir` under
  `/var/lib/theta-gateway/redis`, AOF on) but merely `systemctl enable --now
  redis-server`, which loads the distro default — so the gateway's WireGuard
  identity, sessions and OAuth state persisted to the distro path nobody
  documented or backed up, and AOF durability was never enabled. A systemd
  drop-in now points `redis-server` at the gateway config.
- fix: **reconcile is serialized.** A pass dials the directory three times
  (10s timeout each) and can outlive the 60s interval; overlapping passes raced
  on `wg`/`ip`/`iptables` and could stack duplicate rules. A tick that finds a
  pass in flight now skips instead of stacking on it.
- fix: **exit policy rules are diffed, not cleared-and-re-added.** The old
  clear-all-re-add approach blipped every exiting device's routing for a
  window on each 60s pass, and its cleanup deleted any rule in the priority
  range regardless of owner. `applyExits` now removes only stale rules by
  exact match and adds only missing ones — no blip, and an operator rule that
  lands in the range is left alone.
- docs: **rewrote `DEPLOYMENT.md` and `docs/installation.md`** for the
  host-installed gateway (v3.0.0+): the container-era "three ways to run"
  instructions, `ops/install.sh` bare-metal path and `docker compose logs -f
  jump-host` were all dead. Now documents `install.sh` (the real path), where
  config/data live, the Redis drop-in, port-22 options and the roster-driven
  mesh.

## v3.1.3

- fix: **upgrading an already-running gateway no longer fails the port check.**
  The pre-install `ss -lntp` conflict check could not tell the gateway's own
  running SSH front door from an unrelated process, so re-running `install.sh`
  to upgrade a live install died with "port 2222 is already in use" right
  after the gateway had installed successfully. The check now only fails when
  somebody other than the active `theta-gateway` service owns the port —
  compare the listener's pid against the unit's MainPID (empty/0 means the
  service is not running, which is a genuine conflict).

## v3.1.2

- fix: **exit routing rules now read back in the form they were added.** The
  kernel drops the prefix on a host rule — one added as
  `from 10.2.128.1/32` prints as `from 10.2.128.1` — so anything comparing the
  installed rules against the intended ones saw a mismatch that was not there.
- test: **the end-to-end suite checks that exits are APPLIED, not planned.**
  Its exit assertions read `planned.exits` and `planned.exitRules` — the
  planner's output — which is why they passed happily while `applyExits` was
  never being reached at all. They now read the live WireGuard device and the
  kernel's own routing rules, via a new `exitRulesLive` on
  `GET /api/mesh/status`, and assert the exit tunnel completed its own
  handshake under the separate exit key.

## v3.1.1

- fix: **install Node instead of refusing to start without it.** The gateway
  used to run in a container carrying its own runtime, so a host never needed
  one; running on the host means it does, and v3.1.0 stopped with "node is
  required" partway through a setup that had already brought the rest of the
  stack up. It now installs Node 22 from NodeSource on apt hosts (Debian and
  Ubuntu ship 18, below the engines floor, so the distro package is not an
  option). `THETA_SKIP_NODE_INSTALL=1` to manage the runtime yourself.
  Verified from nothing on a bare `debian:bookworm-slim`.

## v3.1.0

The gateway installs on the **host** now, not in a container.

- feat: **`install.sh` + a systemd unit.** Installs dependencies, lays the app
  down in `/opt/theta-gateway`, writes `/etc/theta-gateway/gateway.env`, binds
  Redis to loopback, and enables the `theta-gateway` service. Idempotent, so
  re-running upgrades in place; `--uninstall` deliberately keeps
  `/var/lib/theta-gateway`, since that holds this gateway's WireGuard identity
  and every peer in the cluster has its public half.
  - Refuses to start if the SSH port collides with the host's own `sshd`,
    rather than "succeeding" and leaving the operator locked out.
  - Runs as root: creating WireGuard interfaces, writing the routing table,
    setting `net.*` sysctls in the init namespace and installing NAT/NETMAP
    rules all need `CAP_NET_ADMIN` there, and sysctl writes are effectively
    root-only. A capability-scoped user buys ambiguity, not safety.
- fix: **the router threw instead of degrading, and it cost the exits.** The
  container image shipped without `iptables` or `procps`, and `/proc/sys` is
  read-only in a default container — so every NAT, forwarding and NETMAP call
  failed. `applyForwarding` was the one unguarded call in `applyPlan`, so it
  threw mid-reconcile: the NETMAP loop never ran, `applyPlan` never returned,
  and `applyExits` was never reached. Exits were planned and silently never
  applied. `net_router` now detects missing tooling once, says what that costs,
  and configures everything it still can; sysctls fall back to writing
  `/proc/sys` directly when the binary is absent.
- The mesh, device tunnels and site-to-site routing always worked in a
  container. What did not was everything touching the host network — which is
  most of what a router does.

## v3.0.0

**Breaking.** The gateway no longer holds any network configuration of its own.
Sites, devices, LAN mapping and exits are configured in **theta-directory**; the
gateway publishes its public key and endpoint and applies whatever the roster
says. Addressing changed with it, so every site must be rebuilt.

- feat!: **the gateway is a roster-driven router.** Joining the directory *is*
  joining the mesh — the mint-token/register/join dance, the per-gateway
  registry and its independently-allocated index are gone, along with the
  second allocator that could disagree with the first. A site's id is its
  `ldapServerId`, allocated once, cluster-wide, when it joined.
- feat!: **new addressing.** `172.24.0.<siteId>/32` for a gateway's identity,
  `10.<siteId>.0.0/16` for everything at that site, `10.<s>.128.0/17` for
  devices, `10.<s>.168.0/24` and `10.<s>.172.0/24` for LAN mapping. One octet
  per site caps a cluster at 254 — below LDAP's own 4094 ServerID ceiling, so
  the addressing is now the binding constraint.
- feat: **full router.** `ip_forward`, MASQUERADE on the auto-detected uplink,
  stateful FORWARD rules, NETMAP of each site's physical LAN into a shadow /24,
  and `rp_filter=0` — without which policy-routed exit traffic silently
  blackholes while every other diagnostic looks healthy. Every iptables rule is
  added behind a `-C` check, since reconcile runs at boot, on every roster
  change, and on a timer.
- feat: **per-device internet exits**, one WireGuard interface each.
  `AllowedIPs` is a single trie per interface, so only one peer can own
  `0.0.0.0/0` and the last to claim it silently takes it from the others; and
  WireGuard routes on destination, ignoring the kernel nexthop, so
  `default via <peer>` cannot select among exits. Devices are steered with
  `ip rule from <device>/32`, so changing an exit rewrites one rule and never
  touches the device — no reconnect, no reissued config.
- fix: **registering a second peer used to delete the first.** `setPrivateKey`
  applied the key with `wg setconf`, which replaces the whole device config and
  removes every peer not in it. Verified against wireguard-go in the gateway
  image: setconf takes 1 peer to 0, `wg set private-key` leaves 2 at 2.
- fix: **the mesh never came back after a restart.** The registry was durable
  and the interface was not, and nothing rebuilt one from the other. Now
  reconciled at boot and on a timer.
- fix: **`'(self)'` was trusted for identity.** That slug arrived in a remote
  gateway's own registration body, so a peer could claim to be us. Identity now
  comes from the public key, which never crosses the wire.
- feat: directory config is cached in Redis and reconcile falls back to it, so
  the gateway keeps routing through a directory outage.
- feat: the mesh UI is now diagnostics — what the roster asked for, what is on
  the wire, and where they disagree, with named callouts for the states that
  otherwise look identical to healthy (no site id, stale config, interface
  down, no uplink, no NETMAP support, an unbuildable exit).
- removed: `services/mesh_forwarder.js`. It bridged traffic in userspace on a
  port derived from the site index because WireGuard was trapped inside a
  container namespace. With real routing a peer site's directory is just
  `10.<n>.0.2:3001`.
- removed: the roaming-client feature (`routes/wireguard.js`, `wg_peer`,
  `wg_site`, `wg_conf`). It handed out configs and QR codes that could never
  connect — no interface ever received a peer entry for them, and the endpoint
  advertised pointed at the mesh interface, which held the same key but no
  matching peer, so every config downloaded failed its handshake silently.
  Devices are directory-managed now, with keys the server never stores. Its
  `10.100.0.0/16` pool went too; that range collided exactly with a site
  landing on id 100.
- fix: **exit interfaces get their own keypair.** A remote gateway keeps one
  endpoint and one session per peer KEY, so an exit interface presenting the
  same key as the mesh interface made the remote's single peer entry flap
  between the two while they invalidated each other's session — intermittent
  breakage rather than a clean failure. Verified against wireguard-go in the
  gateway image: one key on two interfaces left the remote pointed at whichever
  handshook last, with both still re-handshaking; separate keys give two stable
  peers. The gateway now publishes a second exit key, and an exit site builds a
  peer entry for anyone exiting through it — allowed only the specific device
  addresses using that exit, since an exit is permission to send internet
  traffic, not a route into a network.
- test: three-gateway end-to-end over real WireGuard
  (`docker-compose.mesh-e2e.yml`). Three and not two deliberately — the
  peer-wipe and index bugs above are both structurally invisible with one peer
  per gateway.

## v2.2.0
- feat: **mesh service forwarding** (`services/mesh_forwarder.js`) — the data plane the mesh control plane assumed but never had. WireGuard runs inside this container's network namespace, so the `172.24.<idx>.1` mesh IP a gateway reports is unreachable from the sibling containers (theta-directory, theta-proxy) that were told to use it, and nothing listened on `:3001` there in any case. Relay routes and mesh-preferred replication both pointed at a dead target while the existing ICMP-level tests passed. Now bridged in userspace both ways: ingress `172.24.<own>.1:3001 -> sso-manager:3001` (override with `THETA_MESH_SERVICE_TARGET`), egress `0.0.0.0:<30000+peer> -> 172.24.<peer>.1:3001`. Ports are derived from the peer's mesh index, so nothing is stored or discovered — theta-directory computes the same number in `utils/mesh_route.js`. Forwarders reconcile on every mesh change, so a new peer is reachable without a restart and a removed one stops being reachable immediately.
- test: `docker-compose.mesh-e2e.yml` + `test/mesh_data_plane_e2e.js` — two real gateways over real WireGuard, asserting an HTTP request crosses the tunnel and reaches the far site's service (both directions), and that a removed peer's forwarder stops serving.

## v2.1.1
- fix: **mesh peer removal now cleans up its kernel routes.** `wg_iface.removePeer()` dropped the WireGuard peer entry but left the `ip route` entries `setPeer()` had added, so a removed peer's subnet stayed routed into a dead tunnel. Fixed by querying `wg show <iface> allowed-ips` before removal and `ip route del`-ing each CIDR. Verified live: routes present after `setPeer`, gone after `removePeer`, this gateway's own local route untouched. Exposed via `DELETE /api/mesh/gateways/:id` + a remove button in the mesh UI.
- feat: **`GET /api/mesh/self`** — this gateway's own mesh IP, gated by any valid self-service API token rather than a full jump-admin session, so an unattended local script (e.g. `theta-suite`'s no-inbound relay bootstrap) can discover it without admin credentials.
- fix: **`/api/mesh/register` was unreachable via HTTP.** `routes/api.js` mounted `/` (admin-session-gated `routes/jump.js`) before `/mesh`; since `router.use('/', ...)` matches every `/api/*` path, every `/api/mesh/*` request — including `/register`, authenticated by a bearer mesh join token, not an admin session — hit that admin gate first and 401'd before `routes/mesh.js` ever ran. A real gateway-to-gateway `/join` call failed with a `checkApiToken`/`LoginFailed` error instead of registering. Found live-testing the new `/self` endpoint with two real containers; fixed by mounting `/mesh` first.
- fix: **the initiating side of a mesh join never recorded its own identity.** `POST /register` (the receiving side) persists a `(self)` registry entry via `ensureOwnMeshIndex()`, but `POST /join` (the initiating side) never did, so `GET /api/mesh/self` and the mesh UI's own-entry handling silently saw nothing on whichever gateway called `/join`. Fixed by registering a self-entry there too, using the exact mesh index the remote assigned (`models/mesh_gateway.js`'s `register()` now accepts an explicit `meshIndex` instead of always auto-picking one from the local registry). Verified with two real meshed containers: both sides now report their own correct mesh IP.

## v2.1.0
- feat: **Gateway-to-gateway WireGuard mesh** (`routes/mesh.js`) — real site-to-site tunnels between theta-gateway instances, distinct from the existing roaming-client/exit-node WireGuard feature. Join-token bootstrap (`POST /api/mesh/join-tokens`, `/register`, `/join`), mesh-index addressing (172.24.\<idx\>.0/16 + 10.\<idx\>.0.0/16, per `theta-suite`'s `docs/MULTI_SITE_SPEC.md`).
- feat: **In-kernel WireGuard with a userspace fallback** (`utils/wg_iface.js`) — prefers `ip link add type wireguard`, falls back to `wireguard-go` when the kernel module isn't available (older/hardened kernels, some container images, non-Linux). Both packages added to the Dockerfile.
- feat: **mDNS local-discovery announcer** (`services/mdns_announce.js`) — advertises which public hostnames this site fronts (opt-in via `THETA_LOCAL_DISCOVERY_HOSTS`) so a `theta-agent` on the same LAN segment can skip the relay/WAN path. Companion piece to `theta-agent`'s discovery listener.
- feat: **Mesh UI** (`/mesh`) — gateway identity (interface, kernel-vs-userspace mode), join-token minting, remote-join form, meshed-gateways table.
- Verified with real two-container tests, not mocks: an actual encrypted WireGuard tunnel passing ICMP traffic end to end (0% loss), and the mDNS announce/discover/apply/revert cycle over real multicast. Two real bugs found and fixed along the way: `wg set ... allowed-ips` doesn't add a kernel route (a real handshake completed with zero routing, `ping` still failed, until `setPeer()` was fixed to add `ip route add` itself); and mDNS's default IPv6 query aborting the entire lookup — discarding an already-valid IPv4 response — when IPv6 isn't available.

## v2.0.1
- docs: **Rebranded to Theta Gateway across the docs.** README title/links updated; removed the "Standalone Docker" and "Bare metal" install paths, which contradicted the Deployment section's own "exclusively via Docker Compose within Theta Suite" claim. Fixed stale links to the old per-repo GitHub Pages sites (`sso-manager-node`, `theta-env`) — now point at the unified `theta42.github.io/theta-suite/` docs site.

## v2.0.0
- feat: **WireGuard Gateway Management UI & API.** Integrated complete WireGuard exit node management (`/wireguard`), client peer creation with instant QR code rendering and `.conf` configuration file downloads.
- feat: **Automatic WireGuard Bootstrap.** Automatically generates an X25519 gateway keypair on initial boot if missing and registers the local default exit node (`718it (This Site)`).
- feat: **Query Token Authentication.** Added `?token=` parameter fallback to `middleware/auth.js` for direct browser `.conf` profile file downloads.
- fix: **UI Confirm Banners.** Added `actionMessage` container placeholders to cards for `app.messages.confirm()` rendering.

## v1.19.1
- docs: README.md and docs/architecture.md described host-access authorization as a client-side loop over each of a user's LDAP groups (`GET /api/discovery/resources?group=<cn>` per group). The actual code (`utils/access.js`, `accessibleHosts()`) makes one call to the SSO's `GET /api/discovery/access/:uid`, which resolves the user's groups server-side. Corrected both.

## v1.19.0
- fix: **only catalog hosts are jump targets.** `isManagedHost` treated a missing `metadata.managed` flag as permission, so any host the SSO merely *discovered* — an unpromoted Proxmox guest, a UniFi client — was offered in the TUI picker and accepted by the username grammar. The filter is now `isCatalogHost`, mirroring the SSO Directory's own rule: a resource carrying `discovery_sources` but never promoted is excluded, while hand-created hosts (no `discovery_sources`) and promoted ones (`managed: true`) are included, and an explicit `managed: false` is always excluded.
- test: regression coverage for all five cases (hand-made, discovered-unpromoted, discovered-promoted, `manual` source, explicitly unmanaged).
- docs: `docs/connecting.md` states that discovery results are not jump targets until promoted into the catalog.

## v1.18.0
- feat: Add SSO-style error page (404/500) for browser navigation instead of a bare text response
- feat: navbar — username no longer underlined; only the active link is bold + underlined

## v1.16.1
- fix: remove missing DEPLOYMENT.md from Docker build context

## v1.16.0
- Added OpenBao PKI SSH Certificate Support
- Fallback to LDAP Key injection

# v1.15.0
- feat: Rename SSO Manager to Jump in UI

# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
correspond to git tags (`vX.Y.Z`) and `nodejs/package.json`'s `version`.

## [1.14.1] - 2026-08-01

### Fixed
- **Bumped `@simpleworkjs/bao-conf` to 1.0.1** so standalone/no-OpenBao boots
  don't crash. bao-conf 1.0.0's `init()` threw when `VAULT_TOKEN` was unset,
  which — combined with `bin/www`'s `.catch(() => process.exit(1))` — made the
  jump host exit at boot in any deployment without an OpenBao sidecar
  (standalone Docker, bare metal). 1.0.1 makes `init()` fail-soft on a missing
  token (warn + continue from `CONF_SECRETS`), matching the documented
  contract. The theta-env stack is unaffected (it always sets a scoped
  `VAULT_TOKEN`).

## [1.14.0] - 2026-08-01

### Changed
- **Secrets now load from OpenBao at boot** via
  [@simpleworkjs/bao-conf](https://simpleworkjs.github.io/bao-conf/), which
  deep-merges `secret/jump-host/conf` over the file-loaded config. The jump
  host authenticates to OpenBao with a scoped `VAULT_TOKEN` (policy
  `jump-host` — read-only on its own path), never the root token. Because the
  OIDC `clientSecret` is captured at require time inside `createOidcClient`
  (during `require('../models')`), `bin/www` now runs `bao-conf.init()`
  **before** `require('../models')`. Fail-soft: if OpenBao is unreachable,
  boot continues from `CONF_SECRETS`. The `config/jump-secrets.js` file is now
  an operator-edit seed artifact (gitignored); OpenBao is authoritative. See
  theta-env's [Secrets docs](https://theta42.github.io/theta-env/secrets/).
- Bumped package version to track the release tag.

## [1.11.0] - 2026-07-30

### Added
- **`app_super_admin` (cross-app) and `app_jump_admin` groups**: super admins are full admins here same as `app_sso_admin`; jump admins get audit page/data access without other admin rights. The Audit page/API is now actually admin-gated server-side (previously the page shell rendered for any logged-in user, only its data was gated).
- **Host list adds Last connection/Last failed connection columns** and highlights rows green (a session is live right now) or yellow (the most recent attempt failed), backed by new per-host last-success/last-fail timestamps in `models/metrics.js`. `services/ssh_server.js` now attributes grammar/TUI connect failures to the resolved host when one was found, not just aggregate counters.

### Changed
- **Dashboard's stat boxes and Top hosts/Top users cards moved to the Audit page** (audit is now the admin-facing metrics home; dashboard stays focused on "hosts I can reach"). "All hosts" renamed to "My hosts".

## [1.10.2] - 2026-07-30

### Changed
- **Dashboard, Sessions, and Audit pages now match sso-manager-node/proxy's page width**, wrapping content in a standard container instead of rendering full-bleed inside the fluid shell.
- **Audit's nav entry is now admin-gated** (`groups: ['admin']` in `utils/ui.js`), reusing the existing synthetic-admin-group nav-gating convention — the API route was already server-side admin-gated; this hides the nav link for non-admins too.

## [1.10.1] - 2026-07-28

### Fixed
- **The API-token reveal modal silently didn't show after creating a token** — `submitApiToken()` called `app.modal.close()` immediately before `showToken()`'s `app.modal.open()` in the same tick, colliding with Bootstrap's hide-transition guard on the singleton modal. Same root cause as the OAuth-secret-reveal race fixed in sso-manager-node (v1.8.2) and the create-token race fixed in proxy (v1.7.0).

## [1.10.0] - 2026-07-28

### Added
- **API-token UI unified with sso-manager-node/proxy**: card grid replacing the bare table, a new Edit modal (footer shows real created-by/on data), and a Description field on both the create and edit flows — the model and API already fully supported all of this, it just wasn't exposed anywhere in the dashboard.

### Changed
- `@simpleworkjs/frontend` bumped to `^0.2.6` (this app was still on `^0.2.5`).

## [1.9.0] - 2026-07-28

### Added
- **"Quick Jump" copy-to-clipboard section on the dashboard** — the `uid_-_target` grammar-mode SSH command was documented in the README but nowhere in the UI. A new card gives a one-click-copy command for interactive-picker mode, and every row in "Hosts you can reach" has its own copy button for the exact grammar-mode command to that host, ready to paste and run as-is (uses the logged-in user's own uid).

## [1.8.2] - 2026-07-28

### Fixed
- **Audit records for a failed upstream connection only ever said `upstream-unreachable`** — `resolveAndConnect` discarded the real error from `connectUpstream` (ECONNREFUSED, ETIMEDOUT, an ssh2 auth-failure message, etc.) and replaced it with that one generic string, so there was no way to tell a network-layer failure from an auth failure from the audit log alone. This is what blocked root-causing the "Could not reach 192.168.1.206" (emby host) report — the real error is now captured and surfaced as a new `failDetail` field on the audit record, shown as a tooltip on the fail badge in the admin audit table.

## [1.8.1] - 2026-07-28

### Fixed
- **Redis had zero persistence** (`--save '' --appendonly no`, no data-dir volume) — every container rebuild/recreation silently wiped all sessions, in-flight OAuth logins, and any admin-created API token. This is why re-running `setup.sh` appeared to "break OAuth with jump": the jump-host container gets recreated, and any token or in-flight login vanished with it. Now Redis persists (AOF + periodic RDB) to `/data`, mounted as a named volume (`jump-redis-data`) in theta-env's compose file. Verified live: minted a PAT, force-recreated the container, confirmed the same PAT still authenticated afterward.

## [1.8.0] - 2026-07-28

### Fixed
- **TUI-mode SSH connections (a bare `ssh user@host`, no target) could drop with "PTY allocation request failed" / "shell request failed"** — `runTuiSession` awaited two real round-trips (an audit-log write, then a directory API call) *before* attaching the session's pty/shell/exec listeners, so a client that sent those requests quickly enough got auto-rejected by ssh2 before anything was listening. `runGrammar` (the `uid_-_target` path) already had the equivalent fix; this ports it to the picker path.
- **`formAJAX`'s loading indicator showed literal HTML**, not a spinner — same fix as sso-manager-node/proxy's companion releases.

## [1.7.1] - 2026-07-28

### Added
- **Regression test**: a static check across all views/client-side scripts fails CI if any native `alert()`/`confirm()`/`prompt()` call appears — these block all further browser events on the page. This app has never had one; keeps it that way.

## [1.7.0] - 2026-07-27

### Added
- **Self-service API tokens (PATs)** — `models/api_token.js` + `routes/api_token.js` (mounted at `/api-token`), Bearer-token support in `middleware/auth.js`, and a create/list/rotate/revoke card on the dashboard. Ports proxy's `jmp_<id>_<secret>` pattern; unlike proxy's, a jump-host token carries no group claims, so it authenticates as its creator for non-admin routes only (never passes `requireAdmin`). jump-host previously had no PAT support at all.

## [1.6.0] - 2026-07-27

### Changed
- **Adopted `@simpleworkjs/frontend`'s `app.messages`, `app.modal`, and `app.validate` modules**, replacing the vendored `app.util.actionMessage`/`actionConfirm` in `public/lib/js/app-base.js` and the vendored `public/lib/js/val.js` (unused by any current view here, so this is dedup/future-proofing rather than a behavior change). `app.api`/`app.auth`/`app.pubsub`/`app.socket` are untouched.

## [1.5.0] - 2026-07-27

### Added
- **Web UI dashboard now lists the hosts you can reach** ("Hosts you can reach", or "All hosts" for admins) — previously the dashboard only showed usage metrics, with no way to see your actual access from the browser. Backed by a new `GET /api/user/hosts` endpoint (auth-only, not admin-gated): admins get the full inventory via `utils/access.js`'s new `allHosts()`, everyone else gets the same group-based resolution the SSH front door uses.
- `utils/access.js`'s `accessibleHosts()` now accepts a pre-resolved `groups` array on the user object, skipping the LDAP `getGroups(dn)` round-trip — the web UI's OIDC session already has its groups claim and has no LDAP `dn` to query with.

### Fixed
- **Bumped `@simpleworkjs/ldap` to 1.0.1**, which fixes `addSshKey` throwing `ObjectClassViolationError` (LDAP `0x41`) on accounts predating the `ldapPublicKey` auxiliary objectClass. This is the code path this jump host's key-injection (`utils/key_inject.js`) uses on every first connection for a user — on affected accounts it aborted the SSH connection entirely (`key-inject-failed`).

## [1.4.0] - 2026-07-26

### Added
- **Standalone mode** — run the jump host with no LDAP directory and no SSO Manager at all. Set `standalone.enabled: true` and user authentication and host discovery switch to `@simpleworkjs/orm`-backed stores (Sequelize; SQLite by default, any Sequelize-supported dialect via `conf.orm`) instead of the directory services. `models/user_ldap.js` and `utils/access.js` become conditional facades that pick their backend at require time — `ssh_server.js`, `bridge.js`, `key_inject.js`, `tui_picker.js`, and the web UI are unchanged either way.
- New ORM models: `StandaloneUser` (`uid`, `passwordHash`, `sshPublicKeys`, `groups`) and `StandaloneHost` (`slug`, `displayName`, `kind`, `metadata`), plus `models/user_file.js` and `utils/hosts_file.js`, which implement the same interfaces as the LDAP client and `accessibleHosts()` respectively. There's no admin UI for standalone users/hosts yet — see the README's "Standalone mode" section for the ORM-model seeding snippet. In standalone mode every stored host is reachable by every stored user; there's no group-based authorization yet.
- 47 tests pass (24 existing + 15 new unit + 3 existing integration + 5 new standalone integration).

### Fixed
- **`services/ssh_server.js` used `|| 2222` for the listen port**, so an explicit `listenPort: 0` (ephemeral port, used by the test suite) was silently overridden back to 2222. Changed to `?? 2222`.
- **`services/ssh_server.js` awaited `audit.create()` before registering session listeners.** A client that sends `exec`/`shell` immediately after connecting could have its request dropped because nothing was listening yet. Listener registration now happens first.

## [1.3.0] - 2026-07-26

### Changed
- **Unified the front-end UI shell across the three theta42 apps.** `views/top.ejs`, `views/bottom.ejs` and `public/lib/js/app-base.js` are now byte-identical in sso-manager-node, proxy and jump-host, so the apps look and behave the same and a shell change lands in one edit per repo instead of three divergent ones. Everything that differs between the apps moved into a new `nodejs/utils/ui.js`, exposed to every render as `ui` via `app.locals`: nav items and the groups that may see them, footer repo/license/docs/Terms links, favicon, the profile and post-logout targets, and whether the update banner exists at all.
- **One nav-gating model everywhere.** `app-base.js` reveals `.group-required-<cn>` elements for each group the current user is in, read from `GET /api/user/me`. sso-manager-node reports LDAP DNs in `memberOf` and the OIDC clients report CNs in `groups`; both normalise to CNs client-side, and the clients' effective-rights `isAdmin` flag is exposed as a synthetic `admin` group — so one gating model covers a group-based provider and boolean-admin clients without either app learning the other's response shape.
- **`GET /api/user/me` is fetched once per page load and cached** (`app.auth.loadUser`). The nav, per-view `forceLogin` and every group-gated element read that one promise instead of issuing their own request.
- `app.auth.isLoggedIn` is dual-mode: it returns a Promise **and** invokes an optional node-style callback, so the async and callback call styles both work against one shared `top.ejs`.
- `app.auth.forceLogin` no longer uses `$.holdReady` (removed in jQuery 4). An unauthenticated user is redirected to `/login?redirect=<path>`; group requirements are still enforced, and `logOut` now only clears the session, leaving the destination to the caller (`ui.logoutRedirect`).
- Dependency alignment across all three apps: `jquery` `^4.0.0` and `ejs` `^3.1.10`.

### Fixed
- **`app.api.delete` dropped its callback when called by `formAJAX`.** `formAJAX` always passes the serialized form as the second argument, so a DELETE-method form's callback landed in the data slot and never ran. `delete` now accepts both `(url, callback)` and `(url, data, callback)`.
- **`app.api.post`/`put` referenced an undefined `callback2`** and threw when handed a non-function callback. Both are now dual-mode Promise/callback.
- **The login page's "reveal the card once we know you're logged out" branch threw** (`Cannot read properties of null`) whenever the logged-in check answered before the parser reached that element — which it always did without a stored token. It now runs on DOM ready.
- **`logInRedirect` on the legacy `/login/<path>` form kept only the path.** The OIDC provider routes an unauthenticated authorization request through `/login/oauth/authorize?client_id=…&state=…`; dropping the query there loses the entire authorization request. The suffix form now preserves its query string.

### Added
- `.group-required { display: none }` in `public/css/styles.css`, the base rule the shared gating model reveals against.
- `#spa-shell` dropped its inline `margin-top`; `styles.css` already sets it and the shared shell adjusts it when a banner is shown.

### Verified
- Browser-verified against a full theta-env stack (sso-manager + proxy + jump-host): every top-level page renders with a clean console; nav gating is correct for admin and non-admin; `forceLogin`'s onboarding and group gates fire; `val.js` blocks a weak password and accepts a strong one through a real form submit; the DELETE-method forms work; and the OIDC login round trip (authorize with PKCE -> login -> consent -> callback -> token fragment) completes on both OIDC clients.

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
