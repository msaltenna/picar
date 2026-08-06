'use strict';

// Wire the bitrate controller to the bitrate sink, driven by the telemetry loop's WiFi
// sample.
//
// WHY THIS MODULE EXISTS AT ALL, rather than a few lines in app.js. `app.js` has no test
// file, and across eight review rounds this repo's dominant defect has been "a correct rule
// with an untouched consumer" — a tested rule whose only call site was where the bug lived.
// Two adversarial reviews on 2026-08-06 found that shape again on the abandoned h264 branch.
// So the wiring itself is a function a test can drive, and app.js holds one line.
//
// WHY IT RIDES THE TELEMETRY TICK instead of owning a timer. The telemetry loop already
// reads /proc/net/wireless once a second and already carries `wifi.signalDbm`. A second
// interval would mean a second /proc read and another timer on the event loop that runs the
// input watchdog — invariant 9 territory for no benefit. One sample source also means
// /status and the controller can never disagree about the signal.
//
// NOTHING HERE MAY THROW INTO THE TICK. It is invoked from inside the telemetry loop, which
// also sets the Fleet Manager battery-trouble bit and broadcasts telemetry. An exception
// escaping this module would take those down and, under the crash fail-safe, the process
// with them. Every entry point is wrapped, and the sink already promises never to reject.
//
// ADAPTATION ONLY EVER REDUCES. The ladder is built from the tracked configuration as its
// ceiling (see buildLadder). The worst this can do to an operator on a good link is give
// them the quality they configured; it cannot raise offered load above it.

const { createBitrateController, buildLadder } = require('./video-bitrate-controller');
const { createBitrateSink } = require('./video-bitrate-sink');
const { spawn } = require('child_process');

// Read the negotiated tx rate from `iw`, or null. This is the one useful number that is not
// already in /proc/net/wireless, and it separates two failure modes the 2026-08-06 drive could
// not distinguish: a weak-but-fast link (loss) from a strong-but-collapsed one (MCS fallback).
//
// spawn, not exec: no shell, and no buffering of output nobody reads. Called at the TRACE
// interval (0.2 Hz), never per tick. It resolves null on every failure path — a missing `iw`,
// a non-zero exit, unparseable output, or the timeout — because an absent number must never
// look like a good one.
function makeTxBitrateReader(iface = 'wlan0', timeoutMs = 2000) {
  return function readTxBitrate() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      let child;
      try {
        child = spawn('iw', ['dev', iface, 'link'], { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (_) { return finish(null); }
      // Bounded: a hung `iw` must not leak a child per trace for the life of the process.
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish(null); }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      let out = '';
      // Bound the buffer too. `iw link` output is a few hundred bytes; anything larger means
      // something is wrong and is not worth accumulating on the control process's heap.
      child.stdout.on('data', (d) => { if (out.length < 8192) out += d; });
      child.on('error', () => { clearTimeout(timer); finish(null); });
      child.on('close', () => {
        clearTimeout(timer);
        const m = /tx bitrate:\s*([0-9.]+\s*[A-Za-z/]+)/i.exec(out);
        finish(m ? m[1].replace(/\s+/g, '') : null);
      });
    });
  };
}

// The decision half, with no knowledge of where samples come from.
function createAdaptiveBitrate({
  controller,
  sink,
  log = console.log,
  now = () => Date.now(),
  // Periodic signal trace. WITHOUT THIS AN OBSERVE-MODE DRIVE PRODUCES NOTHING: the loop
  // otherwise logs only when it DECIDES a step, so if the dBm thresholds are too pessimistic
  // to ever fire — which is the leading hypothesis, since they have never been exercised —
  // the journal would record silence and we would be back to impressions. The trace is what
  // makes the thresholds fittable: signal over time, alongside the rung the controller held
  // and what it was leaning towards. 5 s is ~12 lines a minute, cheap in the journal and
  // fine-grained enough to line up against MediaMTX's own session and discard messages.
  traceEveryMs = 5000,
  // Reads the negotiated tx rate, or null. Injected so this module never reaches for a
  // subprocess itself and so tests can drive it. It is called at the TRACE interval (0.2 Hz),
  // never per tick — spawning is cheap at that rate and asynchronous either way, but the
  // history of pwm_libgpiod spawning ~200 processes a second on this platform is the reason
  // to state the rate explicitly rather than leave it to be discovered.
  readTxBitrate = null,
} = {}) {
  if (!controller || typeof controller.sample !== 'function') {
    throw new TypeError('createAdaptiveBitrate requires a controller');
  }
  if (!sink || typeof sink.applyProfile !== 'function') {
    throw new TypeError('createAdaptiveBitrate requires a sink');
  }

  let lastApplied  = null;
  let lastOutcome  = null;
  let applyErrors  = 0;
  let lastTraceAt  = null;
  let lastRetries  = null;      // cumulative counter; the RATE is what means anything
  let txBitrate    = null;      // refreshed asynchronously, so a trace may show the prior value

  // Called once per telemetry tick with the snapshot. Returns the controller's decision so
  // a test can assert it; the return value is not used in production.
  function onTelemetry(snapshot) {
    try {
      // A missing or non-finite reading is NOT treated as a good link. The controller maps
      // an unreadable signal to the lowest rung, but only after its full sustain window, so
      // one failed /proc read costs nothing while a persistently unreadable one steps down.
      const wifi = snapshot && snapshot.wifi;
      const signalDbm = wifi && typeof wifi.signalDbm === 'number' ? wifi.signalDbm : null;
      const at = now();
      const decision = controller.sample({ signalDbm, at });

      // Trace first, and unconditionally, so a run that never steps still yields the data.
      if (traceEveryMs > 0 && (lastTraceAt === null || at - lastTraceAt >= traceEveryMs)) {
        const elapsedMs = lastTraceAt === null ? null : at - lastTraceAt;
        lastTraceAt = at;
        try {
          const rung = controller.current();
          const pending = decision && decision.pendingTarget !== null && decision.pendingTarget !== undefined
            ? controller.profiles[decision.pendingTarget].name
            : 'none';

          // Retries per second, differenced here because the kernel counter is cumulative.
          // A counter that only ever goes up tells you nothing at a glance; a rate does.
          const nowRetries = wifi && typeof wifi.retries === 'number' ? wifi.retries : null;
          let retryRate = 'n/a';
          if (nowRetries !== null && lastRetries !== null && elapsedMs > 0) {
            const d = nowRetries - lastRetries;
            // A negative delta means the counter reset (interface reinit); report rather than
            // print a nonsensical negative rate.
            retryRate = d < 0 ? 'reset' : `${(d / (elapsedMs / 1000)).toFixed(1)}/s`;
          }
          if (nowRetries !== null) lastRetries = nowRetries;

          log(`video-adaptive: trace signal=${signalDbm === null ? 'unreadable' : signalDbm + 'dBm'} ` +
              `tx=${txBitrate === null ? 'n/a' : txBitrate} retries=${retryRate} ` +
              `rung=${rung.name}(${rung.bitrateKbps}k@${rung.fps}) pending=${pending} ` +
              `reason=${(decision && decision.reason) || 'none'}`);
        } catch (_) { /* a trace must never break the loop */ }

        // Refresh the tx rate for the NEXT trace. Deliberately not awaited: this runs inside
        // the telemetry tick, and a subprocess must never put its latency on the path that
        // also feeds the fail-safe's event loop.
        if (typeof readTxBitrate === 'function') {
          try {
            Promise.resolve(readTxBitrate())
              .then((v) => { txBitrate = typeof v === 'string' && v ? v : null; }, () => { txBitrate = null; });
          } catch (_) { txBitrate = null; }
        }
      }

      if (!decision || !decision.change) return decision || null;

      const profile = decision.change;
      // Fire and forget by design: awaiting a yml write inside the telemetry tick would put
      // filesystem latency on the path that also feeds the fleet heartbeat. The sink
      // serialises internally, so overlapping calls cannot interleave writes.
      sink.applyProfile(profile).then((outcome) => {
        lastOutcome = outcome;
        // `=== true`, not truthiness. The sink's contract is a boolean, but an outcome of
        // `{applied: {}}` — an EMPTY applied set, i.e. nothing was applied — is truthy, and
        // would be logged as a successful step. Given how much of this session was spent on
        // things reporting success they had not achieved, the strict comparison is worth the
        // character count.
        if (outcome && outcome.applied === true) {
          lastApplied = profile;
          try {
            log(`video-adaptive: stepped ${decision.reason} to ${profile.name} — ` +
                `${profile.width}x${profile.height}@${profile.fps} ${profile.bitrateKbps}kbps ` +
                `(signal ${signalDbm === null ? 'unreadable' : signalDbm + ' dBm'})`);
          } catch (_) { /* logging must never break the loop */ }
        } else {
          applyErrors++;
          try {
            log(`video-adaptive: step to ${profile.name} NOT applied — ` +
                `${outcome && outcome.reason}`);
          } catch (_) { /* ignore */ }
        }
      }, () => {
        // The sink documents that it never rejects. Handled anyway: relying on that
        // promise would make this an unhandled rejection if it ever changed.
        applyErrors++;
      });

      return decision;
    } catch (err) {
      // Swallowing is correct here. This runs inside the telemetry tick; an exception
      // escaping would stop telemetry broadcasts and the fleet battery-trouble bit, and
      // adaptive video quality is not worth that.
      applyErrors++;
      try { log('video-adaptive: sample failed:', err && err.message); } catch (_) {}
      return null;
    }
  }

  return {
    onTelemetry,
    state: () => ({
      index:       controller.currentIndex(),
      current:     controller.current(),
      lastApplied,
      lastOutcome,
      applyErrors,
    }),
  };
}

// Construct the whole thing from config and the live stream module. Returns null — a
// deliberate, logged no-op — when adaptation cannot or should not run, so app.js needs no
// conditional of its own beyond a null check.
function buildAdaptiveBitrate({
  config = {},
  stream,
  log = console.log,
  now,
  minApplyIntervalMs,
  readTxBitrate,          // test seam; production builds one from `iw` below
} = {}) {
  const enabled = config.video_adaptive_bitrate !== false;   // opt-out, not opt-in
  if (!enabled) {
    log('video-adaptive: disabled by config (video_adaptive_bitrate: false)');
    return null;
  }
  // Only the WebRTC path can apply a bitrate without restarting a service. The h264 and
  // mjpeg paths spawn rpicam-vid themselves and would need a camera respawn with new argv,
  // which is not implemented — so this reports rather than pretending to adapt.
  // Any stream module that can change camera params at runtime at all. WebRTC can; the h264
  // and mjpeg paths spawn rpicam-vid themselves and would need a respawn with new argv, which
  // is not implemented.
  if (!stream || (typeof stream.setParamsNoRestart !== 'function' &&
                  typeof stream.setParams !== 'function')) {
    log(`video-adaptive: inactive — the active stream module cannot change camera params at ` +
        `runtime, so there is nothing to adapt`);
    return null;
  }

  const baseline = {
    width:       config.webrtc_width        || 480,
    height:      config.webrtc_height       || 360,
    fps:         config.webrtc_fps          || 20,
    bitrateKbps: config.webrtc_bitrate_kbps || 350,
  };

  let profiles;
  try {
    profiles = buildLadder(baseline);
  } catch (err) {
    // A bad ladder must not take picar down, and must not silently do nothing either.
    log(`video-adaptive: NOT running — could not build a ladder from the configured ` +
        `${baseline.width}x${baseline.height}@${baseline.fps} ${baseline.bitrateKbps}kbps: ` +
        `${err.message}`);
    return null;
  }

  const controller = createBitrateController({
    profiles,
    // Start at the top: the configured value is what the operator asked for, and the first
    // sustained bad signal steps it down. Starting low would penalise every good link.
    startIndex: profiles.length - 1,
    downSustainMs: config.video_adaptive_down_sustain_ms,
    upSustainMs:   config.video_adaptive_up_sustain_ms,
    minDwellMs:    config.video_adaptive_min_dwell_ms,
    hysteresisDb:  config.video_adaptive_hysteresis_db,
  });

  // ── HOW A RUNG IS APPLIED, and why the default applies nothing ─────────────
  //
  // MEASURED ON ROVER3, 2026-08-06, AND IT REFUTES THE MECHANISM THIS WAS BUILT ON.
  // Writing a new `rpiCameraBitrate` into mediamtx.yml makes MediaMTX log
  // `reloading configuration (file changed)` — and NOT recreate the rpiCamera source. The
  // `mtxrpicam` child kept the same PID at 14 s, 20 s and 40 s after the write while the
  // file plainly held the new value. **The encoder never sees it.**
  //
  // The earlier evidence for a free hot reload was a camera respawn that coincided with
  // picar's own STARTUP yml write, which is a different situation, and generalising from it
  // was wrong. So `setParamsNoRestart` writes a file that changes nothing about the running
  // encoder, and a sink built on it would report `applied` for a step that never happened —
  // the exact lie the sink exists to prevent, one layer below where it can see.
  //
  // Hence two modes, and the default does not pretend:
  //
  //   'observe' (DEFAULT) — decide and LOG, apply nothing. This is not a placeholder: the
  //       dBm thresholds have never been fitted to a real drive, and a run in observe mode
  //       produces exactly the data needed to fit them, at zero cost to the operator's
  //       video. An honest instrument beats a broken actuator.
  //   'restart' — apply by restarting mediamtx, which is proven to work because the UI
  //       video-params path already does it. THE COST IS REAL AND THE OPERATOR MUST CHOOSE
  //       IT: a service restart drops the WebRTC session, so the browser has to renegotiate
  //       — on a degrading link, which is precisely when this fires. That may be worse than
  //       the freeze it is trying to avoid, which is why it is not the default.
  //
  // A respawn-free path remains the right answer and remains unbuilt: the V4L2 encoder's
  // `video_bitrate` control is settable while streaming, but `mtxrpicam` owns the device and
  // whether an external write reaches it is unverified. Tracked in TASKS.md.
  const applyMode = config.video_adaptive_apply === 'restart' ? 'restart' : 'observe';

  const applyFn = applyMode === 'restart'
    ? (p) => stream.setParams(p)
    : (p) => {
        // Report honestly that nothing was applied. The sink treats an empty `applied` as a
        // failure, which is correct here — a rung was decided and deliberately not enforced.
        log(`video-adaptive: OBSERVE ONLY — would apply ${p.width}x${p.height}@${p.fps} ` +
            `${p.bitrate}kbps, but video_adaptive_apply is 'observe' so the encoder is ` +
            `unchanged. Set 'restart' to actually apply it (costs a mediamtx restart).`);
        return Promise.resolve({ applied: {}, rejected: [], restarted: false });
      };

  if (applyMode === 'restart' && typeof stream.setParams !== 'function') {
    log('video-adaptive: NOT running — video_adaptive_apply is \'restart\' but the stream ' +
        'module has no setParams');
    return null;
  }

  const sink = createBitrateSink({
    apply: applyFn,
    minApplyIntervalMs,
    now,
    log,
  });

  log(`video-adaptive: active [apply=${applyMode}] — ladder ` +
      profiles.map((p) => `${p.name}:${p.bitrateKbps}k@${p.fps}`).join(' ') +
      `, ceiling is the tracked ${baseline.bitrateKbps}kbps` +
      (applyMode === 'observe'
        ? '. OBSERVE ONLY: rungs are decided and logged but NOT applied, because writing '
          + 'mediamtx.yml does not reach the encoder (measured 2026-08-06). This run '
          + 'produces the data to fit the dBm thresholds.'
        : '. APPLY VIA MEDIAMTX RESTART: each step drops the WebRTC session.'));

  return createAdaptiveBitrate({
    controller, sink, log, now,
    readTxBitrate: readTxBitrate || makeTxBitrateReader(config.wifi_iface || 'wlan0'),
  });
}

module.exports = { createAdaptiveBitrate, buildAdaptiveBitrate, makeTxBitrateReader };
