'use strict';

// Apply a bitrate profile to the running encoder, safely.
//
// The controller (video-bitrate-controller.js) decides WHAT bitrate the link can afford.
// This applies it. The split matters because applying costs something real — a camera
// respawn, roughly 1-2 s with no video — and everything here exists to bound that cost
// and to report honestly when it did not happen.
//
// MECHANISM 1: write mediamtx.yml and let MediaMTX reload it. Evidenced on 2026-08-05 —
// picar's startup wrote the yml and MediaMTX logged `configuring streams: (0) 320x240`
// with a new camera child while its systemd ActiveEnterTimestamp stayed unchanged. The
// service is never restarted, so this is the cheap path. Notably it is cheaper than what
// the UI path does today: setParams() calls `systemctl restart mediamtx` explicitly,
// which is a strictly larger interruption than the free reload.
//
// Mechanism 2 — setting the V4L2 encoder's bitrate mid-stream, with no respawn at all —
// is unverified on this hardware and slots in behind this same interface once measured.
// The controller and the loop above it do not change when it does.
//
// WHAT THIS GUARDS AGAINST, each pinned by a test:
//
//   * Overlapping applies. Two writes racing would interleave into a malformed yml, and
//     MediaMTX reloads whatever it finds. Serialised through one promise chain.
//   * Wasted respawns. If requests queue up while one is in flight, only the LATEST is
//     applied — intermediate rungs of the ladder are stale by the time they would land,
//     and each one would cost the operator video for a level already superseded.
//   * Thrash from any caller. The controller has its own dwell, but this is a public
//     entry point and must protect itself: an independent minimum interval means a second
//     caller (the UI, a future auto-tune) cannot bypass the bound.
//   * Silent failure. A failed write returns `applied: false` with a reason. The lesson
//     that produced this rule: a UI that reported settings as applied when they were not
//     cost a whole debugging round.
//
// Nothing here throws into its caller. It runs on the control event loop, and a rejected
// promise on a video path must never become an uncaught exception — that is a fail-safe
// path now (see crash-failsafe.js), but relying on it would be backwards.

function createBitrateSink({
  apply,
  minApplyIntervalMs = 5000,
  now = () => Date.now(),
  log = console.log,
} = {}) {
  if (typeof apply !== 'function') {
    throw new TypeError('createBitrateSink requires an apply function');
  }

  let chain = Promise.resolve();
  let inFlight = false;
  let queued = null;              // the LATEST pending profile, not a backlog
  let lastAppliedAt = null;
  let lastApplied = null;

  function tooSoon(at) {
    return lastAppliedAt !== null && (at - lastAppliedAt) < minApplyIntervalMs;
  }

  // Returns a promise that resolves with the outcome. Never rejects.
  function applyProfile(profile) {
    if (!profile || typeof profile !== 'object') {
      return Promise.resolve({ applied: false, reason: 'no profile given' });
    }
    const at = now();
    if (tooSoon(at)) {
      return Promise.resolve({
        applied: false,
        reason: `too soon: ${at - lastAppliedAt}ms since the last apply, minimum ${minApplyIntervalMs}ms`,
        profile,
      });
    }
    if (inFlight) {
      // Replace rather than append. An intermediate rung is stale by the time it would
      // land, and applying it would spend a camera respawn on a level already superseded.
      const superseded = queued;
      queued = profile;
      if (superseded) {
        try {
          log(`video-bitrate: superseded a queued ${superseded.name} with ${profile.name}`);
        } catch (_) { /* logging must never break the apply path */ }
      }
      return Promise.resolve({ applied: false, reason: 'queued behind an in-flight apply', profile });
    }

    inFlight = true;
    chain = chain.then(() => run(profile));
    return chain;
  }

  async function run(profile) {
    let outcome;
    try {
      const res = await apply({
        width:   profile.width,
        height:  profile.height,
        fps:     profile.fps,
        bitrate: profile.bitrateKbps,
      });
      // The apply function reports what it actually applied. An empty `applied` means the
      // values were rejected downstream — that is a failure, not a success, and treating
      // it as success is exactly the lie this project has paid for twice.
      const appliedKeys = res && res.applied ? Object.keys(res.applied).length : 0;
      if (res && res.error) {
        outcome = { applied: false, reason: `apply failed: ${res.error}`, profile };
      } else if (appliedKeys === 0) {
        outcome = { applied: false, reason: 'apply reported nothing applied', profile };
      } else {
        lastAppliedAt = now();
        lastApplied = profile;
        outcome = { applied: true, reason: null, profile, detail: res.applied };
        try {
          log(`video-bitrate: applied ${profile.name} — ${profile.width}x${profile.height}` +
              `@${profile.fps} ${profile.bitrateKbps}kbps`);
        } catch (_) { /* ignore */ }
      }
    } catch (err) {
      // Never let this become an unhandled rejection on the control event loop.
      outcome = { applied: false, reason: `apply threw: ${err && err.message}`, profile };
    } finally {
      inFlight = false;
    }

    // Drain the single queued request, if one arrived while we were working AND the
    // interval now permits it. Checking the interval here too means a queued request
    // cannot sidestep the bound it would have hit on arrival.
    const next = queued;
    queued = null;
    if (next && !tooSoon(now())) {
      inFlight = true;
      return run(next);
    }
    if (next) {
      try { log(`video-bitrate: dropped queued ${next.name} — inside the minimum interval`); }
      catch (_) { /* ignore */ }
    }
    return outcome;
  }

  return {
    applyProfile,
    lastApplied: () => lastApplied,
    isInFlight: () => inFlight,
    queued: () => queued,
  };
}

module.exports = { createBitrateSink };
