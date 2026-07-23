'use strict';

// Base configuration. Deep-merged (by @simpleworkjs/conf) with
// conf/<NODE_ENV>.js, then the CONF_SECRETS file, then app_* env vars —
// later sources win. Everything here is a safe default; deployment-specific
// values (LDAP creds, SSO API token) belong in the secrets file.

module.exports = {
	name: 'Jump Host',

	// LDAP directory the users live in (same directory the SSO manages).
	// bindDN needs: read on ou=people (users + sshPublicKey) and ou=groups,
	// and WRITE on the sshPublicKey attribute (for upstream key injection —
	// see utils/key_inject.js and the README's ACL section).
	ldap: {
		url: 'ldap://localhost:389',
		bindDN: '__in secrets file__',
		bindPassword: '__in secrets file__',
		userBase: 'ou=people,dc=example,dc=com',
		groupBase: 'ou=groups,dc=example,dc=com',
		userNameAttribute: 'uid',
		tlsOptions: { rejectUnauthorized: false },
	},

	// SSO Manager — the directory (inventory) API. apiToken is a personal
	// access token (sso_<id>_<secret>) of a user that can read
	// /api/discovery/* (any authenticated user can).
	sso: {
		url: 'http://localhost:3001',
		apiToken: '__in secrets file__',
	},

	ssh: {
		listenHost: '0.0.0.0',
		listenPort: 2222,
		// Directory the generated host keys live in (created on first boot).
		hostKeyPath: '/var/lib/jump-host/keys',
		banner: '',
		// Password auth policy: 'off' (keys only), 'local' (passwords allowed
		// only from loopback/RFC1918 client addresses — keys-only from the
		// public internet), or 'all'. Default 'local'.
		passwordAuth: 'local',
		// Allow bridging to a raw IP that is NOT a directory host the user
		// has access to. Off by default: the directory is the authority.
		allowRawIPs: false,
		connectTimeoutMs: 10000,
		// 0 disables the idle timeout.
		idleTimeoutMs: 0,
		maxSessions: 100,
		// Comment appended to the injected public key in LDAP. Also used to
		// EXCLUDE that key from inbound auth (only the jump host may hold
		// that private key). theta-env sets this to jump-host@<siteName>.
		keyComment: 'jump-host@local',
		// metadata key on directory hosts for a nonstandard sshd port.
		defaultPort: 22,
	},

	web: {
		port: 3002,
	},

	auth: {
		// LDAP groups whose members may use the web UI/API.
		adminGroups: ['app_sso_admin'],
		// Web session lifetime (ms).
		sessionTTLms: 12 * 60 * 60 * 1000,
	},

	redis: {
		prefix: 'jump_host_',
		redisConf: {},
	},

	audit: {
		// Keep at most this many audit events (oldest trimmed).
		maxEvents: 50000,
	},

	// Orchestrator-only keys (ignored by the app, read by theta-env).
	stack: {},
};
