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
// Optional telemetry snapshot included in each heartbeat. The status BITMASK stays
// authoritative for warnings so an older Fleet Manager keeps working unchanged;
// this is purely additive detail for a newer dashboard to display.
let _telemetry = null;

const DISCOVERY_PORT_DEFAULT = 3000;
const PROBE_TIMEOUT_MS       = 500;   // per-host probe timeout
const PROBE_CONCURRENCY      = 40;    // parallel probes per batch
const FAIL_THRESHOLD         = 2;     // consecutive heartbeat failures before re-discovering
// Failed sweeps back off exponentially from the tick interval up to this ceiling,
// so a rover on a subnet with no Fleet Manager stops burning CPU on it.
const MAX_SWEEP_BACKOFF_MS   = 5 * 60 * 1000;

function getLocalIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function setTelemetry(t) { _telemetry = t; }

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

// Exponential backoff for failed discovery sweeps.
//
// Extracted and exported so the reset-on-success path is testable: with this inline
// in tick(), deleting the reset left the whole suite green, so a rover that found a
// Fleet Manager and then lost it would have kept the ceiling delay forever.
//
// Uses a caller-supplied `now`, so tests need no timers and the delay does not
// depend on wall-clock jumps within a single comparison.
class SweepBackoff {
  constructor(intervalMs, maxMs) {
    this.intervalMs = intervalMs;
    this.maxMs = maxMs;
    this.delayMs = 0;
    this.nextAt = 0;   // 0 = due immediately
  }

  dueNow(now) { return this.nextAt === 0 || now >= this.nextAt; }

  fail(now) {
    this.delayMs = this.delayMs === 0
      ? this.intervalMs
      : Math.min(this.delayMs * 2, this.maxMs);
    this.nextAt = now + this.delayMs;
    return this.delayMs;
  }

  succeed() { this.delayMs = 0; this.nextAt = 0; }
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
  const backoff = new SweepBackoff(intervalMs, MAX_SWEEP_BACKOFF_MS);

  function heartbeatTo(base) {
    const payload = JSON.stringify({
      id:        roverId,
      ip:        getLocalIp(),
      timestamp: Math.floor(Date.now() / 1000),
      status:    _statusBits,
      telemetry: _telemetry,
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

    // Back off between failed sweeps.
    //
    // A sweep is up to 254 TCP connects at 40-way concurrency with a 500 ms
    // timeout, so it occupies roughly 3 s of every 5 s tick. On a rover whose
    // subnet has no Fleet Manager — a common, indefinite state — that ran
    // forever, measured at ~7% of a core on a Compute Module 4 while otherwise
    // idle. That CPU is shared with the 20 Hz control loop and the camera
    // encoder, so a cosmetic dashboard feature was competing with the control
    // path. Discovery is not urgent: nothing about the vehicle depends on it.
    if (!backoff.dueNow(Date.now())) return;

    discovering = true;
    try {
      const ip = await discover(discoveryPort);
      if (ip) {
        currentBase = `http://${ip}:${discoveryPort}`;
        backoff.succeed();
        console.log(`Fleet Manager discovered at ${currentBase}`);
        heartbeatTo(currentBase);
      } else {
        const delayMs = backoff.fail(Date.now());
        console.log('Fleet Manager not found on LAN; next sweep in ' +
          `${Math.round(delayMs / 1000)}s.`);
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

module.exports = { start, setStatusBit, setTelemetry, SweepBackoff, MAX_SWEEP_BACKOFF_MS };
