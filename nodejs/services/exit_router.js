'use strict';

// Internet exits: sending a chosen device's traffic out of a chosen site.
//
// WHY EACH EXIT NEEDS ITS OWN INTERFACE
//
// WireGuard keeps AllowedIPs as a single trie per interface, so a prefix
// belongs to exactly one peer -- and the last peer to claim it silently takes
// it from the others. Two peers on one interface both claiming 0.0.0.0/0
// therefore does not give you two exits; it gives you one, whichever was
// configured last.
//
// Worse, WireGuard routes on the packet's DESTINATION and ignores the kernel
// nexthop entirely, so the obvious workaround does not work either:
//
//     ip route add default via <peer mesh ip> dev wg-mesh table exit_nl
//
// hands the packet to wg-mesh, which looks up 8.8.8.8, finds whichever peer
// owns 0.0.0.0/0, and sends it there -- the `via` is decorative. That is why
// the hand-written config this replaces had its second exit rule commented
// out: it could never have worked.
//
// So: one interface per exit, each with a single peer owning 0.0.0.0/0, and
// policy routing selects the INTERFACE:
//
//     ip rule from 10.2.128.7/32 lookup exit_nl
//     ip route add default dev wg-exit-nl table exit_nl
//
// Exit nodes are consequently peered twice -- once on wg-mesh for their site
// network, once on their own exit interface for internet traffic. That is
// wasteful by a keepalive and is the only arrangement in which "pick an exit"
// is expressible at all.

const wgIface = require('../utils/wg_iface');
const netRouter = require('../utils/net_router');

// Routing tables are numbered; names live in /etc/iproute2/rt_tables, which we
// do not edit. Numbers avoid touching a system file and are what `ip` stores
// anyway. Base chosen well clear of the reserved low tables (main=254,
// default=253, local=255) and of anything a distro is likely to add.
const TABLE_BASE = 2400;
// Rule priority. Below the kernel's main-table rule (32766) so it wins for the
// clients it names, and above 0 so local/host rules still take precedence.
const RULE_PRIORITY_BASE = 3000;

const ifaceFor = (siteId) => `wg-exit-${siteId}`;
const tableFor = (siteId) => TABLE_BASE + Number(siteId);

function run(cmd, args) { return netRouter._tryRun(cmd, args); }

/** Exit interfaces currently on the box, as a map of siteId -> ifname. */
function listExitInterfaces() {
	const res = run('ip', ['-o', 'link', 'show']);
	const found = new Map();
	if (!res.ok) return found;
	for (const line of res.out.split('\n')) {
		const m = /^\d+:\s+(wg-exit-(\d+))[:@]/.exec(line.trim());
		if (m) found.set(Number(m[2]), m[1]);
	}
	return found;
}

/**
 * Decide the exit configuration from the roster and the local device list.
 * Pure -- the rules here are what matter, and they are testable without
 * touching a routing table.
 *
 * @param {Array} clients  local devices, each with assignedIp + exitSiteId
 * @param {Array} sites    the roster (for each exit's endpoint and key)
 * @param {number} localSiteId
 */
function planExits(clients, sites, localSiteId) {
	const byId = new Map((sites || []).map((s) => [Number(s.siteId), s]));
	const exits = new Map();
	const rules = [];
	const unusable = [];

	for (const client of clients || []) {
		const exitId = client.exitSiteId;
		if (exitId === null || exitId === undefined || exitId === '') continue;
		const id = Number(exitId);

		// A device pointed at THIS site exits locally -- that is just the
		// default route, no interface and no rule.
		if (id === Number(localSiteId)) continue;

		const site = byId.get(id);
		if (!site || !site.gatewayPublicKey || !site.gatewayEndpoint) {
			// Naming the reason matters: "your VPN stopped working" is
			// otherwise indistinguishable from a dead tunnel.
			unusable.push({
				client: client.assignedIp,
				exitSiteId: id,
				reason: !site ? 'no such site in the roster'
					: !site.gatewayPublicKey ? 'that site has not published a public key'
						: 'that site has no reachable endpoint'
			});
			continue;
		}

		if (!exits.has(id)) {
			exits.set(id, {
				siteId: id,
				slug: site.slug || `site-${id}`,
				iface: ifaceFor(id),
				table: tableFor(id),
				publicKey: site.gatewayPublicKey,
				endpoint: site.gatewayEndpoint,
				// The single peer that owns the default route on this
				// interface, and the reason the interface exists.
				allowedIPs: ['0.0.0.0/0', '::/0'],
				keepalive: 25
			});
		}
		rules.push({
			from: `${client.assignedIp}/32`,
			table: tableFor(id),
			priority: RULE_PRIORITY_BASE + id,
			exitSiteId: id
		});
	}

	return { exits: [...exits.values()], rules, unusable };
}

/**
 * Apply the plan. Idempotent, and reconciles DOWN as well as up: an exit no
 * longer chosen by anyone has its interface torn down, and a rule for a device
 * that has moved or been deleted is removed. A stale `ip rule` is worse than a
 * missing one -- it silently routes a device somewhere it is no longer
 * permitted to go.
 */
async function applyExits(plan, identity) {
	const applied = [];
	const failed = [];

	for (const exit of plan.exits) {
		try {
			await wgIface.ensureInterface(exit.iface);
			// No listen port: an exit interface only ever dials out, so binding
			// one would just be another open UDP port on the host.
			wgIface.setPrivateKey(exit.iface, identity.privateKey, null);
			wgIface.setAddresses(exit.iface, []);
			// setPeer would try to add a kernel route for 0.0.0.0/0 into the
			// MAIN table, which would hijack this host's own default route.
			// The default for an exit belongs only in that exit's own table.
			wgIface.setPeerNoRoutes(exit.iface, {
				publicKey: exit.publicKey,
				endpoint: exit.endpoint,
				allowedIPs: exit.allowedIPs,
				keepalive: exit.keepalive
			});
			run('ip', ['route', 'replace', 'default', 'dev', exit.iface, 'table', String(exit.table)]);
			netRouter.applySysctls([exit.iface]);
			applied.push(exit.iface);
		} catch (err) {
			failed.push({ iface: exit.iface, error: err.message });
			console.error(`[exit] could not bring up ${exit.iface}: ${err.message}`);
		}
	}

	// Rules: diff against what is actually installed rather than
	// clear-all-re-add. The clear-all approach is a 60-second packet blip for
	// every device using an exit (there is a window with no rule routing its
	// traffic while they are re-added), and its cleanup pass -- deleting
	// anything in the priority range -- would also remove an operator rule that
	// happened to land in it. Removing only rules that no longer match the
	// plan, and only ones this module could have created, fixes both.
	const installed = listManagedRules();
	const wantedFrom = new Set(plan.rules.map((r) => r.from));

	// Remove stale rules: ours, in range, not wanted any more.
	for (const rule of installed) {
		if (wantedFrom.has(rule.from)) continue;
		const res = run('ip', ['rule', 'del', 'from', rule.from, 'lookup', String(rule.table), 'priority', String(rule.priority)]);
		if (!res.ok) failed.push({ rule: rule.from, error: res.err });
	}

	// Add missing rules: planned but not present. No-op when already there.
	for (const rule of plan.rules) {
		if (installed.some((r) => r.from === rule.from && Number(r.table) === Number(rule.table))) continue;
		const res = run('ip', ['rule', 'add', 'from', rule.from, 'lookup', String(rule.table), 'priority', String(rule.priority)]);
		if (!res.ok) failed.push({ rule: rule.from, error: res.err });
	}

	// Tear down interfaces nobody exits through any more.
	const wanted = new Set(plan.exits.map((e) => e.siteId));
	for (const [siteId, iface] of listExitInterfaces()) {
		if (wanted.has(siteId)) continue;
		console.log(`[exit] removing ${iface} — no device exits through site ${siteId}`);
		run('ip', ['route', 'flush', 'table', String(tableFor(siteId))]);
		run('ip', ['link', 'del', 'dev', iface]);
	}

	return { applied, failed, rules: plan.rules.length, unusable: plan.unusable };
}

/**
 * Remove every rule this module owns, identified by priority range so an
 * operator's own rules are never touched.
 */
function clearManagedRules() {
	const res = run('ip', ['-o', 'rule', 'show']);
	if (!res.ok) return 0;
	let removed = 0;
	for (const line of res.out.split('\n')) {
		const m = /^(\d+):\s+from\s+(\S+)\s+lookup\s+(\S+)/.exec(line.trim());
		if (!m) continue;
		const priority = Number(m[1]);
		if (priority < RULE_PRIORITY_BASE || priority > RULE_PRIORITY_BASE + 254) continue;
		if (run('ip', ['rule', 'del', 'priority', String(priority)]).ok) removed++;
	}
	return removed;
}

/**
 * The policy-routing rules this module currently owns, read back from the
 * kernel. Identified by the priority range, so an operator's own rules are
 * never reported as ours.
 *
 * Exists because "the rule was planned" and "the rule is installed" are
 * different claims, and only the second one routes a packet.
 */
function listManagedRules() {
	const res = run('ip', ['-o', 'rule', 'show']);
	if (!res.ok) return [];
	const rules = [];
	for (const line of res.out.split('\n')) {
		const m = /^(\d+):\s+from\s+(\S+)\s+lookup\s+(\S+)/.exec(line.trim());
		if (!m) continue;
		const priority = Number(m[1]);
		if (priority < RULE_PRIORITY_BASE || priority > RULE_PRIORITY_BASE + 254) continue;
		// The kernel drops a /32 on readback: a rule added as
		// `from 10.2.128.1/32` prints as `from 10.2.128.1`. Normalise it back so
		// a caller can compare what it asked for against what is installed
		// without knowing that quirk.
		const from = /^\d{1,3}(\.\d{1,3}){3}$/.test(m[2]) ? `${m[2]}/32` : m[2];
		rules.push({ priority, from, table: m[3] });
	}
	return rules;
}

/** Live state for the UI: which exit interfaces exist, their handshakes, and
 * which devices are actually steered to them right now. */
function exitStatus() {
	const out = {};
	for (const [siteId, iface] of listExitInterfaces()) {
		out[siteId] = { iface, peers: wgIface.peerStatus(iface) };
	}
	return out;
}

module.exports = {
	planExits, applyExits, clearManagedRules, listExitInterfaces, listManagedRules, exitStatus,
	ifaceFor, tableFor, TABLE_BASE, RULE_PRIORITY_BASE
};
