// fleetmgr-client.js — periodic heartbeat to the Fleet Manager.
//
// fleetManagerUrl in picar-cfg.json controls how the FM is located:
//   ""            -> disabled (no heartbeat)
//   "auto"        -> OS-agnostic auto-discovery (recommended): sweep the local
//                    /24 over plain unicast TCP for a host answering
//                    GET /api/fleet-id, then heartbeat to it. Works no matter
//                    where the FM runs (native Linux, WSL, Windows, Pi, Mac) —
//                    it relies only on unicast TCP, the one transport that
//                    survives WSL's NAT (mDNS/broadcast do not).
//   "http://host:port" -> fixed URL (legacy / explicit).
//
// Status bitmask: bit 0 = battery trouble, bit 1 = not mobile
'use strict';

const http = require('http');
const os   = require('os');

let _statusBits = 0x00;

const DISCOVERY_PORT_DEFAULT = 3000;
const PROBE_TIMEOUT_MS       = 500;   // per-host probe timeout
const PROBE_CONCURRENCY      = 40;    // parallel probes per batch
const FAIL_THRESHOLD         = 2;     // consecutive heartbeat failures before re-discovering

function getLocalIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function setStatusBit(bit, value) {
  if (value) _statusBits |=  (1 << bit);
  else       _statusBits &= ~(1 << bit);
}

// Candidate hosts to probe: every address in the /24 of each non-internal
// IPv4 interface (deduped). A /24 keeps the sweep bounded (~254 hosts).
function candidateIps() {
  const nets = new Set();
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        nets.add(iface.address.split('.').slice(0, 3).join('.'));
      }
    }
  }
  const ips = [];
  for (const base of nets) {
    for (let i = 1; i <= 254; i++) ips.push(`${base}.${i}`);
  }
  return ips;
}

// Probe one host: resolve true iff it answers GET /api/fleet-id as the FM.
function probeFleetId(ip, port) {
  return new Promise(resolve => {
    const req = http.get(
      { host: ip, port, path: '/api/fleet-id', timeout: PROBE_TIMEOUT_MS },
      res => {
        if (res.statusCode !== 200) { res.resume(); return resolve(false); }
        let data = '';
        res.on('data', c => { data += c; if (data.length > 512) req.destroy(); });
        res.on('end', () => {
          try { resolve(JSON.parse(data).service === 'picar-fleet-manager'); }
          catch { resolve(false); }
        });
      });
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Sweep the LAN in bounded-concurrency batches; return the first FM IP found.
async function discover(port) {
  const ips = candidateIps();
  for (let i = 0; i < ips.length; i += PROBE_CONCURRENCY) {
    const batch = ips.slice(i, i + PROBE_CONCURRENCY);
    const hits  = await Promise.all(
      batch.map(ip => probeFleetId(ip, port).then(ok => (ok ? ip : null))));
    const found = hits.find(Boolean);
    if (found) return found;
  }
  return null;
}

function start(config) {
  const fleetUrl = config.fleetManagerUrl;
  if (!fleetUrl) return;

  const roverId       = config.rover_id ?? 1;
  const intervalMs    = (config.fleet_heartbeat_interval_s || 5) * 1000;
  const autoMode      = String(fleetUrl).trim().toLowerCase() === 'auto';
  const discoveryPort = config.fleet_discovery_port || DISCOVERY_PORT_DEFAULT;

  let currentBase = autoMode ? null : fleetUrl;  // resolved FM base URL
  let discovering = false;
  let fails       = 0;

  function heartbeatTo(base) {
    const payload = JSON.stringify({
      id:        roverId,
      ip:        getLocalIp(),
      timestamp: Math.floor(Date.now() / 1000),
      status:    _statusBits,
    });
    try {
      const u = new URL('/api/heartbeat', base);
      const req = http.request({
        hostname: u.hostname,
        port:     u.port || 80,
        path:     u.pathname,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, res => { res.resume(); if (res.statusCode === 200) fails = 0; });
      req.on('error', e => {
        console.error('Fleet heartbeat error:', e.message);
        if (autoMode && ++fails >= FAIL_THRESHOLD) { currentBase = null; fails = 0; }
      });
      req.write(payload);
      req.end();
    } catch (e) {
      console.error('Fleet heartbeat error:', e.message);
      if (autoMode && ++fails >= FAIL_THRESHOLD) { currentBase = null; fails = 0; }
    }
  }

  async function tick() {
    if (currentBase) { heartbeatTo(currentBase); return; }
    if (!autoMode || discovering) return;
    discovering = true;
    try {
      const ip = await discover(discoveryPort);
      if (ip) {
        currentBase = `http://${ip}:${discoveryPort}`;
        console.log(`Fleet Manager discovered at ${currentBase}`);
        heartbeatTo(currentBase);
      } else {
        console.log('Fleet Manager not found on LAN; will retry.');
      }
    } finally {
      discovering = false;
    }
  }

  tick();
  setInterval(tick, intervalMs);
  console.log(autoMode
    ? `Fleet heartbeat: auto-discovery (port ${discoveryPort}) rover_id=${roverId} every ${intervalMs / 1000}s`
    : `Fleet heartbeat: ${fleetUrl} rover_id=${roverId} every ${intervalMs / 1000}s`);
}

module.exports = { start, setStatusBit };
