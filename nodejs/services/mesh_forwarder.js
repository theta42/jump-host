'use strict';

// Mesh service forwarding — the data plane the mesh control plane assumed but
// never had (MULTI_SITE_SPEC.md §5).
//
// The problem it solves: WireGuard lives in THIS container's network
// namespace. The mesh IP a gateway reports (172.24.<idx>.1) is this
// container's address, and nothing else at either site can use it:
//
//   * A remote master pushing replication to `http://<meshIp>:3001` reached
//     this container on a port nothing listens on (the directory is a
//     separate container; this one serves :3002).
//   * A no-inbound relay route created on the master's theta-proxy pointed at
//     172.24.<idx>.1, which the proxy container cannot route to at all — the
//     mesh subnet exists only inside the peer gateway's namespace, not on the
//     docker bridge the proxy sits on.
//
// So the relay route and the mesh-preferred resync push both aimed at a dead
// target, and the mesh only ever carried gateway-to-gateway ICMP.
//
// Both directions are bridged here in userspace, deliberately, rather than
// with kernel forwarding + NAT + per-container routes: it needs no NET_ADMIN
// on the OTHER containers, no routing table edits on the docker bridge, and
// no privileged setup beyond the NET_ADMIN this container already has for
// WireGuard itself.
//
//   INGRESS  172.24.<own>.1:3001  ->  sso-manager:3001   (this site's directory)
//   EGRESS   0.0.0.0:<30000+peer> ->  172.24.<peer>.1:3001 (over the tunnel)
//
// Egress ports are DERIVED from the peer's mesh index, never stored: a caller
// that knows a peer's mesh IP (which encodes the index) can compute the port
// with no extra lookup and no new config to keep in sync. theta-directory
// does exactly that in utils/mesh_route.js.

const net = require('net');
const meshGateway = require('../models/mesh_gateway');
const { MESH_SUBNET_PREFIX } = require('../utils/mesh_addressing');

// Base for derived egress ports. 30000 + meshIndex (1-254) stays clear of the
// app's own ports and of the ephemeral range on every platform we run on.
const MESH_SERVICE_PORT_BASE = 30000;
// The port a site's directory serves on, at both ends of the hop.
const DIRECTORY_PORT = 3001;

function directoryTarget() {
	const raw = process.env.THETA_MESH_SERVICE_TARGET || `sso-manager:${DIRECTORY_PORT}`;
	const [host, port] = raw.split(':');
	return { host, port: Number(port || DIRECTORY_PORT) };
}

function meshIpFor(index) {
	return `${MESH_SUBNET_PREFIX}.${index}.1`;
}

function egressPortFor(meshIndex) {
	return MESH_SERVICE_PORT_BASE + Number(meshIndex);
}

// Live listeners, keyed so a peer set change only touches what changed.
const listeners = new Map(); // key -> net.Server

// Pipes one accepted connection to `target`, tearing both ends down together.
// A relay is transparent: it never parses what flows through it, exactly like
// utils/ldap_tunnel.js on the directory side.
function pipeTo(client, target, label) {
	const upstream = net.connect(target.port, target.host);
	let closed = false;
	const shutdown = () => {
		if (closed) return;
		closed = true;
		client.destroy();
		upstream.destroy();
	};

	upstream.on('connect', () => {
		client.pipe(upstream);
		upstream.pipe(client);
	});
	upstream.on('error', (err) => {
		console.error(`[mesh-forwarder] ${label}: upstream ${target.host}:${target.port} failed: ${err.message}`);
		shutdown();
	});
	client.on('error', shutdown);
	upstream.on('close', shutdown);
	client.on('close', shutdown);

	// Neither side should hold a socket open forever if it goes quiet mid-
	// stream; the same leak the directory's LDAP relay had.
	client.setTimeout(10 * 60 * 1000, shutdown);
	upstream.setTimeout(10 * 60 * 1000, shutdown);
}

function listen({ key, host, port, target, label }) {
	if (listeners.has(key)) return;
	const server = net.createServer((client) => pipeTo(client, target, label));
	server.on('error', (err) => {
		// EADDRNOTAVAIL on the ingress listener is the normal state before
		// wg0 has an address; the retry loop below picks it up once it does.
		console.error(`[mesh-forwarder] ${label}: cannot listen on ${host}:${port}: ${err.message}`);
		listeners.delete(key);
		try { server.close(); } catch (e) { /* already closing */ }
	});
	server.listen(port, host, () => {
		console.log(`[mesh-forwarder] ${label}: ${host}:${port} -> ${target.host}:${target.port}`);
	});
	listeners.set(key, server);
}

function stop(key) {
	const server = listeners.get(key);
	if (!server) return;
	try { server.close(); } catch (e) { /* already closed */ }
	listeners.delete(key);
}

// Reconciles listeners against the current peer set. Called at boot and again
// whenever the mesh changes (a peer joins, registers, or is removed), so a
// newly-meshed site becomes reachable without restarting the gateway.
async function syncMeshForwarders() {
	let gateways;
	try {
		gateways = await meshGateway.list();
	} catch (err) {
		console.error('[mesh-forwarder] could not read the mesh registry:', err.message);
		return;
	}

	const self = gateways.find((g) => g.siteSlug === '(self)');
	const wanted = new Set();

	// Ingress: make THIS site's directory answer on this gateway's mesh IP,
	// which is the address every remote peer was already told to use.
	if (self && self.meshIndex) {
		const key = `ingress:${self.meshIndex}`;
		wanted.add(key);
		listen({
			key,
			host: meshIpFor(self.meshIndex),
			port: DIRECTORY_PORT,
			target: directoryTarget(),
			label: `ingress site ${self.meshIndex}`
		});
	}

	// Egress: one local port per peer, reachable by name from the sibling
	// containers on this site's docker network (proxy, sso-manager).
	for (const peer of gateways) {
		if (!peer.meshIndex || peer.siteSlug === '(self)') continue;
		const key = `egress:${peer.meshIndex}`;
		wanted.add(key);
		listen({
			key,
			host: '0.0.0.0',
			port: egressPortFor(peer.meshIndex),
			target: { host: meshIpFor(peer.meshIndex), port: DIRECTORY_PORT },
			label: `egress to site ${peer.meshIndex}`
		});
	}

	// Drop listeners for peers that are gone (a removed gateway must stop
	// being reachable, same reasoning as removePeer cleaning up its routes).
	for (const key of [...listeners.keys()]) {
		if (!wanted.has(key)) {
			console.log(`[mesh-forwarder] dropping ${key} (no longer in the mesh)`);
			stop(key);
		}
	}
}

let retryTimer = null;

// wg0's address is applied asynchronously at bootstrap, and the ingress
// listener cannot bind before it exists. Rather than ordering the boot
// sequence around it, re-reconcile on an interval: it is idempotent, and it
// also picks up peer changes made directly against the model.
function startMeshForwarders({ intervalMs = 30000 } = {}) {
	syncMeshForwarders();
	if (retryTimer) clearInterval(retryTimer);
	retryTimer = setInterval(syncMeshForwarders, intervalMs);
	if (retryTimer.unref) retryTimer.unref();
}

function stopMeshForwarders() {
	if (retryTimer) clearInterval(retryTimer);
	retryTimer = null;
	for (const key of [...listeners.keys()]) stop(key);
}

module.exports = {
	startMeshForwarders, stopMeshForwarders, syncMeshForwarders,
	egressPortFor, meshIpFor, directoryTarget,
	MESH_SERVICE_PORT_BASE, DIRECTORY_PORT,
	_listeners: listeners
};
