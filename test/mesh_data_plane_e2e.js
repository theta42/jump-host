'use strict';

// Does the mesh actually CARRY traffic for a site's services?
//
// The control plane was verified before this: two gateways mesh, peers show
// up, ICMP crosses the tunnel. But every consumer of the mesh addressed
// 172.24.<idx>.1:3001 directly, and that address is only reachable inside the
// peer gateway's own network namespace -- not from the theta-directory or
// theta-proxy containers that needed it, and nothing was listening on :3001
// there in any case. So no-inbound relay routes and mesh-preferred
// replication both resolved to a dead target while every existing test passed.
//
// This drives the real thing: mesh two gateways over real WireGuard, then
// make a request the way theta-directory/theta-proxy now do --
// gateway-a:<30000+B's index> -- and require the response to come from site
// B's directory, on the far side of the tunnel.

const GATEWAY_A_URL = process.env.GATEWAY_A_URL || 'http://gateway-a:3002';
const GATEWAY_B_URL = process.env.GATEWAY_B_URL || 'http://gateway-b:3002';
const A_PASS = process.env.GATEWAY_A_ADMIN_PASS || '';
const B_PASS = process.env.GATEWAY_B_ADMIN_PASS || '';
const ADMIN_USER = 'jumpadmin';

let failed = false;
const fail = (m) => { console.error('MESH DATA PLANE E2E FAIL:', m); failed = true; };
const step = (m) => console.log('--- ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealthy(url, label) {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch (_) { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error(`${label} never became healthy`);
}

async function login(url, password, label) {
  const r = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // jump-host's shared oidc-client router expects `username`, not `uid`.
    body: JSON.stringify({ username: ADMIN_USER, password })
  });
  if (!r.ok) throw new Error(`${label} login failed: ${r.status} ${await r.text()}`);
  const body = await r.json();
  if (!body.token) throw new Error(`${label} login returned no token`);
  return body.token;
}

async function api(url, path, { method = 'GET', token, body } = {}) {
  const r = await fetch(`${url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'auth-token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
  return { status: r.status, body: json };
}

async function main() {
  step('Waiting for both gateways to be healthy');
  await waitForHealthy(GATEWAY_A_URL, 'gateway-a');
  await waitForHealthy(GATEWAY_B_URL, 'gateway-b');

  const tokenA = await login(GATEWAY_A_URL, A_PASS, 'gateway-a');
  const tokenB = await login(GATEWAY_B_URL, B_PASS, 'gateway-b');

  step('Minting a mesh join token on gateway-b');
  const mint = await api(GATEWAY_B_URL, '/api/mesh/join-tokens', { method: 'POST', token: tokenB });
  if (mint.status !== 200 || !mint.body.token) fail(`mint failed: ${mint.status} ${JSON.stringify(mint.body)}`);

  step('Joining gateway-a into gateway-b\'s mesh (real WireGuard)');
  const join = await api(GATEWAY_A_URL, '/api/mesh/join', {
    method: 'POST',
    token: tokenA,
    body: { remoteEndpoint: GATEWAY_B_URL, joinToken: mint.body.token }
  });
  if (join.status !== 200) fail(`join failed: ${join.status} ${JSON.stringify(join.body)}`);

  const aIndex = join.body.meshIndex;
  const bIndex = join.body.peerMeshIndex;
  if (!aIndex || !bIndex) fail(`expected both mesh indexes from the join, got ${JSON.stringify(join.body)}`);
  console.log(`    gateway-a index ${aIndex}, gateway-b index ${bIndex}`);

  step('Confirming both gateways report the tunnel');
  const selfA = await api(GATEWAY_A_URL, '/api/mesh/self', { token: tokenA });
  if (!selfA.body.meshIp) fail(`gateway-a reports no mesh IP: ${JSON.stringify(selfA.body)}`);

  // The forwarders reconcile on mesh changes and on an interval; give the
  // listeners a moment to bind after the join.
  await sleep(3000);

  // THE point of this test. 30000 + peer index is the port derived by
  // theta-directory's utils/mesh_route.js and jump-host's mesh_forwarder.js
  // from the same scheme, with nothing stored or discovered in between.
  const egressPort = 30000 + Number(bIndex);
  step(`Requesting gateway-a:${egressPort} -- must arrive at site B's directory across the tunnel`);
  let body = null;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://gateway-a:${egressPort}/`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) { body = (await r.text()).trim(); break; }
    } catch (e) { /* forwarder not bound yet, or tunnel still settling */ }
    await sleep(1000);
  }
  if (body !== 'SITE-B') {
    fail(`expected SITE-B through the tunnel, got ${JSON.stringify(body)} -- the mesh is not carrying service traffic`);
  } else {
    console.log('    reached site B\'s directory over the WireGuard tunnel');
  }

  step('Checking the reverse direction (gateway-b -> site A) works the same way');
  const reversePort = 30000 + Number(aIndex);
  let reverse = null;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://gateway-b:${reversePort}/`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) { reverse = (await r.text()).trim(); break; }
    } catch (e) { /* still settling */ }
    await sleep(1000);
  }
  if (reverse !== 'SITE-A') {
    fail(`expected SITE-A on the reverse path, got ${JSON.stringify(reverse)}`);
  }

  step('Removing the peer and confirming its forwarder stops serving');
  const gateways = await api(GATEWAY_A_URL, '/api/mesh/gateways', { token: tokenA });
  const peer = (gateways.body.gateways || []).find((g) => g.siteSlug !== '(self)' && Number(g.meshIndex) === Number(bIndex));
  if (!peer) {
    fail(`could not find the peer entry to remove: ${JSON.stringify(gateways.body.gateways)}`);
  } else {
    const del = await api(GATEWAY_A_URL, `/api/mesh/gateways/${peer.id}`, { method: 'DELETE', token: tokenA });
    if (del.status !== 200) fail(`peer removal failed: ${del.status} ${JSON.stringify(del.body)}`);

    let stillServing = true;
    for (let i = 0; i < 15; i++) {
      try {
        const r = await fetch(`http://gateway-a:${egressPort}/`, { signal: AbortSignal.timeout(2000) });
        await r.text();
      } catch (e) { stillServing = false; break; }
      await sleep(1000);
    }
    if (stillServing) {
      fail('the forwarder for a removed peer is still accepting traffic -- removal must close it');
    }
  }

  if (failed) {
    console.error('MESH DATA PLANE E2E: one or more checks failed (see above)');
    process.exit(1);
  }
  console.log('MESH DATA PLANE E2E PASS');
}

main().catch((e) => {
  console.error('MESH DATA PLANE E2E FAIL (exception):', e.stack || e.message);
  process.exit(1);
});
