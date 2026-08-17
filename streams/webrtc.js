// streams/webrtc.js — WebRTC via MediaMTX (https://host:PORT/PATH/whep)
//
// mediamtx.yml is generated at startup from picar-cfg.json — it is not
// committed to git. All camera and WebRTC parameters live in picar-cfg.json
// alongside the h264/mjpeg equivalents.
'use strict';

const fs   = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

// ICE-TCP is OPT-IN, and off by default. This is a safety-relevant default, not a
// preference.
//
// MEASURED ON ROVER3, 2026-08-06. Every WebRTC session during a failed out-of-sight drive
// negotiated ICE over **TCP**, never UDP:
//
//   [session e7b1b545] peer connection established,
//     local candidate: host/tcp/192.168.10.224/8189, remote candidate: prflx/tcp/…
//
// UDP 8189 was bound and listening and the rover has no firewall, so UDP was available on
// the rover's side and simply lost the connectivity checks across that path. WebRTC then
// did what ICE is designed to do — fell back to the next candidate — and that is the
// problem: **the fallback is silent, and TCP is the wrong transport for real-time video.**
// It keeps WebRTC's assumption that it may shed media freely while running on a transport
// with head-of-line blocking that will not let it. The observed result was back-pressure
// into MediaMTX's pipe and a starved hardware encoder: 544 `ioctl(VIDIOC_QBUF) failed` in
// 112 s at only 200 kbps offered, with video stopping for every viewer until the session
// was torn down.
//
// So the default is now UDP or nothing. A link that cannot carry UDP fails immediately and
// visibly, which is strictly better than degrading into a transport that also takes the
// control path down with it — video and commands share half-duplex airtime, and the same
// drive logged 12 `no input for 1000 ms` fail-safe trips in ~100 s.
//
// Verified from the browser side with getStats() on the same day: with UDP reachable the
// selected pair is `prflx/udp/… ↔ host/udp/<rover>:8189`, succeeded and nominated. Chrome
// mDNS-obfuscates its own host candidate, which is why the rover observes `prflx` rather
// than `host` — that is expected and not a symptom.
//
// Set `webrtc_ice_tcp: true` to restore the old behaviour deliberately, knowing the cost.
// Does this board have the hardware H.264 encoder? /dev/video11 is the V4L2 M2M encoder node
// on CM4/Pi4; it is absent on CM5, verified on rover1.
//
// Synchronous, and that is deliberate rather than an oversight: this runs ONCE at config
// generation, not on the control loop, and an async capability check would have to be awaited
// by every caller of generateMediaMTXConfig for no benefit. Overridable for tests.
function hasHardwareEncoder(cfg = {}) {
  if (typeof cfg._hasHardwareEncoder === 'boolean') return cfg._hasHardwareEncoder;
  try { return fs.existsSync(cfg.hw_encoder_node || '/dev/video11'); }
  catch (_) { return false; }
}

function generateMediaMTXConfig(cfg, params) {
  const port    = cfg.webrtc_port     || 8889;
  const udpPort = cfg.webrtc_udp_port || 8189;
  const apiPort = cfg.mediamtx_api_port || 9997;
  // Strict `=== true`: any other value, including a truthy string from a hand-edited
  // overlay, leaves the safe default in place rather than silently enabling TCP.
  const iceTcp  = cfg.webrtc_ice_tcp === true;
  // Omitted entirely rather than set empty — MediaMTX treats an absent key as "no TCP
  // listener", and an empty string has meant "listen on all interfaces" in some config
  // parsers. Absent is the unambiguous form.
  const iceTcpLine = iceTcp ? `webrtcLocalTCPAddress: :${udpPort}\n` : '';
  const keyPath  = cfg.mediamtx_key  || path.join(__dirname, '..', 'certs', 'key.pem');
  const certPath = cfg.mediamtx_cert || path.join(__dirname, '..', 'certs', 'cert.pem');
  const camPath  = (cfg.webrtc_path  || 'cam').replace(/^\/+/, '');

  // ── Encoder capability ──────────────────────────────────────────────────────
  //
  // The fleet is not homogeneous: rover2 and rover3 are CM4s with a hardware H.264 block at
  // /dev/video11; rover1 is a CM5 and has none, so it MUST use softwareH264. Measured with
  // test/on-target/codec-benchmark.sh: software costs 3.3x the encoder CPU at 480x360@20 and
  // 9.7x at 720p30, and it scales with pixel rate where a dedicated block barely notices.
  //
  // Detected rather than configured, so a board swap or a reflash cannot leave a rover with a
  // codec its hardware cannot run — `hardwareH264` on a CM5 yields no video at all. An
  // explicit `webrtc_codec` still wins, because an operator overriding a detection needs to
  // be able to.
  // 'auto' (the shipped default) means DETECT. An explicit codec still wins, for a bisect or
  // an encoder node that exists but is broken.
  //
  // This was `cfg.webrtc_codec || (detect...)`, which never ran the detection in production
  // at all: picar-cfg.json shipped `"webrtc_codec": "hardwareH264"`, so the tracked config
  // always won and a fresh CM5 would still have been handed a codec its hardware cannot run —
  // the exact failure this was added to prevent. The tests missed it because they generated
  // from `{}` rather than from the real shipped config. Found by adversarial review; there is
  // now a test that uses picar-cfg.json itself.
  const wantCodec = cfg.webrtc_codec;
  const codec = (!wantCodec || wantCodec === 'auto')
    ? (hasHardwareEncoder(cfg) ? 'hardwareH264' : 'softwareH264')
    : wantCodec;

  // Profile and level are HARDWARE-encoder options. They were emitted unconditionally, so a
  // rover running software received settings that do not apply to it — harmless, because
  // MediaMTX ignores them, but a generated file that describes an encoder configuration the
  // encoder is not using misleads the next person to tune it.
  const hwProfileLines = codec === 'hardwareH264'
    ? `    rpiCameraHardwareH264Profile: ${cfg.webrtc_h264_profile || 'baseline'}\n` +
      `    rpiCameraHardwareH264Level: '${cfg.webrtc_h264_level || '4.1'}'\n`
    : '';

  // ON-DEMAND IS OPT-IN, AND OFF BY DEFAULT ON THE PINNED MEDIAMTX.
  //
  // The saving is real — rover2 produced 9.58 GB with zero readers — but install.sh pins
  // MediaMTX v1.17.1 (confirmed from rover1's journal), which has a known first-reader race
  // with sourceOnDemand: a player that connects before SPS/PPS are available gets undecodable
  // H.264 and stays BLACK, and the browser only retries if ICE reaches `failed`. Upstream
  // fixed it in v1.19.2.
  //
  // A persistent black stream for the first operator of a teleoperated vehicle is a worse
  // outcome than the encoder cost it saves, so the default stays off until MediaMTX is
  // upgraded and a cold-start WHEP session is validated on hardware. Note the cold-start
  // measurement taken on rover1 (0.60 s to `ready`) CANNOT detect this: path-ready is not the
  // same as a browser decoding frames.
  //
  // Set `webrtc_camera_on_demand: true` to enable it once that upgrade and validation are done.
  const onDemand = cfg.webrtc_camera_on_demand === true;
  const keepWarm = !onDemand || cfg.webrtc_keep_camera_warm === true;
  // Clamped: reachable from the untracked overlay (invariant 8), and 0 would mean "tear the
  // camera down the instant the last viewer leaves", turning every page reload into a camera
  // restart mid-drive.
  const closeAfter = Number(cfg.webrtc_on_demand_close_after_s);
  const onDemandCloseAfterS = Number.isFinite(closeAfter) && closeAfter > 0
    ? Math.min(600, Math.max(10, Math.round(closeAfter))) : 60;

  return `logLevel: info
logDestinations: [stdout]

# Generated by picar at startup from picar-cfg.json — do not edit by hand.
# The API is bound to LOOPBACK ONLY and exists for one reason: reading how many clients are
# pulling the camera. Before this, clientCount() returned a hardcoded 0 - a stub - so a
# second viewer was invisible, which is how a forgotten browser tab streamed through the
# middle of a range test on 2026-08-06, discarding ~42 frames/s while the operator was out
# at distance and nothing on the rover said so. Loopback only: this is diagnostic data on a
# server with no authentication (invariant 1 is open); it must not be reachable off-box.
api: yes
apiAddress: 127.0.0.1:${apiPort}

rtsp: false
rtmp: false
hls: false
srt: false

webrtc: true
webrtcAddress: :${port}
webrtcEncryption: true
webrtcServerKey: ${keyPath}
webrtcServerCert: ${certPath}
webrtcAllowOrigins: ['*']
webrtcLocalUDPAddress: :${udpPort}
${iceTcpLine}webrtcIPsFromInterfaces: true
webrtcIPsFromInterfacesList: []
webrtcAdditionalHosts: []
webrtcHandshakeTimeout: 20s
webrtcTrackGatherTimeout: 10s

paths:
  ${camPath}:
    source: rpiCamera
    # ENCODE ONLY WHEN SOMEONE IS WATCHING. This was hardcoded false, so every rover
    # encoded continuously whether or not a client existed — rover2 was measured having
    # produced 9.58 GB with ZERO readers, and rover1 pays 3.3x for that because its CM5 has
    # no hardware encoder and must use software.
    #
    # sourceOnDemandCloseAfter is what makes this safe for teleop: the camera stays warm
    # for that long after the last viewer leaves, so a reconnect or a page reload never waits
    # for a camera start, while a rover parked with nobody watching stops encoding entirely.
    # Set webrtc_keep_camera_warm: true to restore the old always-on behaviour.
    sourceOnDemand: ${keepWarm ? 'false' : 'true'}
    sourceOnDemandStartTimeout: 10s
    sourceOnDemandCloseAfter: ${onDemandCloseAfterS}s
    rpiCameraCamID: ${cfg.webrtc_cam_id ?? 0}
    rpiCameraWidth: ${params.width}
    rpiCameraHeight: ${params.height}
    rpiCameraFPS: ${params.fps}
    rpiCameraCodec: ${codec}
    rpiCameraIDRPeriod: ${params.idr_period}
    rpiCameraBitrate: ${params.bitrate * 1000}
${hwProfileLines}    rpiCameraDenoise: ${cfg.webrtc_denoise || 'cdn_fast'}
`;
}

module.exports = function createWebRTCStream(config /*, streamServer not used */) {
  const PROTOCOL  = config.webrtc_protocol || 'https';
  const PORT      = config.webrtc_port     || 8889;
  const PATH_NAME = (config.webrtc_path    || 'cam').replace(/^\/+/, '');
  const YML_PATH  = config.mediamtx_yml    || path.join(__dirname, '..', 'mediamtx.yml');

  // Current camera params — mutable via setParams()
  let params = {
    width:      config.webrtc_width        || 480,
    height:     config.webrtc_height       || 360,
    fps:        config.webrtc_fps          || 20,
    bitrate:    config.webrtc_bitrate_kbps || 350,
    idr_period: config.webrtc_idr_period   || 10,
  };

  function writeYml() {
    const content = generateMediaMTXConfig(config, params);
    fs.writeFileSync(YML_PATH, content, 'utf8');
    console.log(`WebRTC: wrote ${YML_PATH}`);
  }

  // Generate the YAML on startup so mediamtx.yml always reflects picar-cfg.json
  writeYml();
  console.log(`WebRTC: WHEP at ${PROTOCOL}://<host>:${PORT}/${PATH_NAME}/whep`);
  console.log(`WebRTC: ${params.width}×${params.height}@${params.fps}fps ${params.bitrate}kbps`);

  // Restart state. A restart takes seconds, and the operator can drag a slider
  // several times in that window; coalesce instead of queueing N restarts, and
  // never run two at once.
  let restarting     = false;
  let restartQueued  = false;
  let restartChild   = null;
  let restartTimer   = null;
  let stopped        = false;

  // `systemctl restart` blocks until the unit's job completes, and a unit stuck in
  // `deactivating` blocks for its full TimeoutStopSec — or indefinitely. Moving it
  // off the event loop is not enough: without a bound, one hung restart would leave
  // `restarting` true forever and every later video-param change would be silently
  // coalesced into a restart that never happens.
  const RESTART_TIMEOUT_MS = config.mediamtx_restart_timeout_ms ?? 30000;

  function clearRestartState() {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    restartChild = null;
    restarting = false;
  }

  function restartMediamtx() {
    if (stopped) return;   // never spawn during or after shutdown
    restarting = true;
    restartQueued = false;
    console.log('WebRTC: restarting mediamtx…');
    // spawn, not exec: no shell, and no buffering of output we do not read.
    const child = spawn('systemctl', ['restart', 'mediamtx'], { stdio: 'ignore' });
    restartChild = child;

    restartTimer = setTimeout(() => {
      console.error(`WebRTC: mediamtx restart exceeded ${RESTART_TIMEOUT_MS} ms — killing it`);
      try { child.kill('SIGKILL'); } catch (_) {}
      clearRestartState();
    }, RESTART_TIMEOUT_MS);
    // Must not hold the process open at shutdown.
    if (typeof restartTimer.unref === 'function') restartTimer.unref();

    child.on('error', (e) => {
      console.error('WebRTC: mediamtx restart failed to spawn:', e.message);
      clearRestartState();
    });
    child.on('close', (code) => {
      clearRestartState();
      if (code === 0) console.log('WebRTC: mediamtx restarted');
      else console.error(`WebRTC: mediamtx restart exited ${code}`);
      // Apply whatever the operator settled on while this restart was running.
      if (restartQueued && !stopped) restartMediamtx();
    });
  }

  // ── Reader count ───────────────────────────────────────────────────────────
  //
  // POLLED AND CACHED, never fetched on demand. clientCount() is called from request and
  // telemetry paths, and invariant 9 makes a synchronous or awaited network call there a
  // safety defect — the input watchdog is a setTimeout on the same loop. So the HTTP GET
  // happens on its own unref'd interval with a hard timeout, and the accessor returns
  // whatever the last successful poll saw.
  //
  // `null`, not 0, when the count is UNKNOWN. This replaced `clientCount() { return 0; }`,
  // a stub that claimed zero viewers on every rover forever — and 0 is a real, actionable
  // answer meaning "nobody is watching". Reporting a guess as a measurement is the failure
  // this whole module keeps running into; an unreachable API must be distinguishable from
  // an idle camera.
  let readerCount   = null;
  let readerPollErr = null;

  const API_HOST = '127.0.0.1';
  const API_PORT = config.mediamtx_api_port || 9997;
  // Finite-integer clamp, not Math.max. `Math.max(1000, "invalid")` is NaN, and Node schedules
  // a NaN interval at 1 ms — an HTTP GET every millisecond on the event loop that carries the
  // 20 Hz override stream and the input watchdog (invariant 9). It also breaks the stall
  // detector below, which counts equal samples rather than elapsed time: at 1 ms, many polls
  // land between two 20 fps frames, so a HEALTHY encoder is declared dead and MediaMTX is
  // restarted. One malformed key in the untracked overlay, two failures. Found by review.
  const READER_POLL_MS = (() => {
    const n = Number(config.webrtc_reader_poll_ms);
    return Number.isFinite(n) ? Math.min(60000, Math.max(1000, Math.round(n))) : 3000;
  })();
  const READER_TIMEOUT_MS   = 1500;

  function pollReaders() {
    if (stopped) return;
    const req = http.get({
      host: API_HOST, port: API_PORT,
      path: `/v3/paths/get/${encodeURIComponent(PATH_NAME)}`,
      timeout: READER_TIMEOUT_MS,
    }, (res) => {
      // Bound the body. This parses a response from a local service, but an unbounded
      // accumulate on a socket that never ends is a leak whatever is on the other end.
      let body = '', len = 0;
      res.on('data', (c) => {
        len += c.length;
        if (len > 64 * 1024) { req.destroy(); return; }
        body += c;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          readerPollErr = `HTTP ${res.statusCode}`;
          return;
        }
        try {
          const parsed = JSON.parse(body);
          readerCount   = Array.isArray(parsed.readers) ? parsed.readers.length : null;
          readerPollErr = readerCount === null ? 'no readers array in API response' : null;
          noteSourceProgress(parsed);
        } catch (e) {
          readerPollErr = `unparseable API response: ${e.message}`;
        }
      });
    });
    req.on('timeout', () => { readerPollErr = 'API timeout'; req.destroy(); });
    req.on('error', (e) => { readerPollErr = e.message; });
  }

  // ── Dead-source detection ──────────────────────────────────────────────────
  //
  // MEASURED ON ROVER2, 2026-08-14. Its hardware encoder entered a permanent failure state:
  // `encoder_hardware_h264_encode(): ioctl(VIDIOC_QBUF) failed` at ~21/s, 229,561 errors and
  // counting. The decisive symptom is not the log spam — it is that the path still reported
  //
  //     ready: true,  readers: 0,  bytesReceived rate: 0 B/s
  //
  // against rover3's healthy 46,840 B/s on identical hardware and identical config. MediaMTX
  // advertises the path as available while producing nothing, so any viewer that connects
  // gets a black screen and no error. Restarting mediamtx is the only known recovery.
  //
  // DETECTED FROM bytesReceived RATHER THAN THE JOURNAL, deliberately. Scraping journalctl for
  // QBUF lines would need a subprocess on a timer and would be coupled to one encoder's error
  // string; this reuses the API poll that already exists for the reader count, costs nothing
  // extra, and measures the thing that actually matters — whether video is being produced.
  //
  // `ready` is the load-bearing guard. With sourceOnDemand the camera is legitimately stopped
  // when nobody is watching, and bytesReceived correctly does not advance then — but the path
  // reports ready:false, so an idle rover is never mistaken for a broken one.
  let lastBytes      = null;
  let stalledPolls     = 0;
  let notReadyPolls    = 0;
  let healthyPolls     = 0;
  let sourceDead       = false;
  let recoveryCount    = 0;     // per-incident, reset after a sustained healthy run
  let totalRecoveries  = 0;     // lifetime, for observability only
  // Whether the camera is genuinely on-demand. Must match what generateMediaMTXConfig wrote,
  // or `ready:false` is misinterpreted in one direction or the other.
  const onDemandEnabled = config.webrtc_camera_on_demand === true
                          && config.webrtc_keep_camera_warm !== true;
  // CLAMPED AS FINITE INTEGERS, not just Math.max'd. `Math.max(2, "invalid")` is NaN, and NaN
  // defeats BOTH guards at once in the unsafe direction: `stalledPolls < NaN` is false, so a
  // perfectly healthy path is declared dead on the first poll, and `recoveryCount >= NaN` is
  // also false, so the restart cap never engages — an endless restart loop on a working
  // rover. Both keys are reachable from the untracked overlay with no review (invariant 8).
  // Found by adversarial review.
  const clampInt = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const STALL_POLLS_TO_DECLARE_DEAD = clampInt(config.webrtc_source_stall_polls, 4, 2, 100);
  const MAX_RECOVERIES              = clampInt(config.webrtc_max_source_recoveries, 3, 0, 20);
  const HEALTHY_POLLS_TO_RESET      = clampInt(config.webrtc_healthy_polls_to_reset, 10, 3, 1000);

  function noteSourceProgress(parsed) {
    const bytes = Number(parsed && parsed.bytesReceived);
    // Not ready = the camera is deliberately stopped (on-demand) or still starting. Neither
    // is a fault, and both must reset the counter or an idle rover would eventually be
    // declared dead and restarted in a loop.
    if (!Number.isFinite(bytes)) { lastBytes = null; stalledPolls = 0; return; }
    if (parsed.ready !== true) {
      // `ready:false` is benign ONLY when the camera is deliberately stopped — that is,
      // on-demand is enabled and nobody is watching. With the shipped always-on config it
      // means the camera FAILED TO START or disappeared, and clearing the fault there
      // reported a rover with no video as healthy: `/status` showed `dead:false`,
      // `readersError:null`, and no recovery was attempted. Found by review, and it is the
      // same "reports healthy while broken" shape this whole branch exists to remove.
      lastBytes = null; stalledPolls = 0;
      if (onDemandEnabled) { sourceDead = false; return; }
      notReadyPolls += 1;
      if (notReadyPolls >= STALL_POLLS_TO_DECLARE_DEAD && !sourceDead) {
        sourceDead = true;
        console.error(
          'WebRTC: the camera path is NOT READY on an always-on configuration — the camera ' +
          'failed to start or has disappeared. No viewer can get video.');
        maybeRecover();
      }
      return;
    }
    notReadyPolls = 0;
    // Three cases, kept distinct on purpose. Folding the first into the third is the bug the
    // first draft of this fix had: a recovery resets lastBytes to null, so the very next poll
    // looked like "forward progress" and cleared the fault it had just raised.
    if (lastBytes === null) {
      stalledPolls = 0;                       // first sample of a window: nothing to compare
    } else if (bytes === lastBytes) {
      stalledPolls += 1;                      // no data produced since the last poll
    } else {
      // GENUINE FORWARD PROGRESS CLEARS THE FAULT. Only `stalledPolls` was reset here
      // originally, so `sourceHealth().dead` stayed true forever after a successful recovery
      // and an operator would see a rover permanently reported broken while its video worked.
      // A stale fault indicator is the same class of defect as a missing one: both stop being
      // read. Found by adversarial review.
      if (sourceDead) {
        console.log('WebRTC: the camera source is producing data again — recovered.');
        sourceDead = false;
      }
      stalledPolls = 0;
      // A SUSTAINED healthy run resets the per-incident attempt budget. The cap exists to
      // bound ONE restart loop, not to be spent across a process lifetime: three separate
      // stalls, each successfully recovered, previously disabled automatic recovery for good,
      // so a later recoverable stall stayed black until someone intervened. `totalRecoveries`
      // keeps the lifetime figure for observability. Found by review.
      healthyPolls += 1;
      if (healthyPolls >= HEALTHY_POLLS_TO_RESET && recoveryCount > 0) {
        console.log(`WebRTC: camera source healthy for ${healthyPolls} polls — ` +
                    'resetting the recovery budget for any future incident.');
        recoveryCount = 0;
      }
    }
    lastBytes = bytes;

    if (stalledPolls < STALL_POLLS_TO_DECLARE_DEAD) return;
    if (!sourceDead) {
      sourceDead = true;
      console.error(
        `WebRTC: the camera source is READY but has produced NO DATA for ${stalledPolls} ` +
        `consecutive polls (${bytes} bytes, unchanged). MediaMTX is advertising a path that ` +
        `delivers nothing — measured on rover2 as a permanently failed hardware encoder.`);
    }
    maybeRecover();
  }

  // Restart mediamtx, bounded and loudly.
  //
  // NOT gated on the reader count, and that is the deliberate choice: a dead source is
  // delivering nothing to anyone, so a viewer has no video to lose. Withholding the restart
  // while someone is connected would preserve a black screen instead of fixing it. The
  // protection against a restart loop is the ATTEMPT CAP plus the ready/bytes guard, not a
  // reader check.
  // Injectable so the CAP is testable. restartMediamtx() sets `restarting` until the spawned
  // child settles, and on a host with no mediamtx unit that timing is unpredictable — which
  // paced attempts so unevenly that a test could not distinguish a capped implementation from
  // an uncapped one. Measured: removing the cap survived the test until this existed. Same
  // dependency-injection reasoning telemetry-loop.js gives for setIntervalFn and readWifi.
  const doRestart = config._restartFn || restartMediamtx;
  const pacedByRestart = !config._restartFn;

  function maybeRecover() {
    if (stopped || (pacedByRestart && restarting)) return;
    if (recoveryCount >= MAX_RECOVERIES) {
      return;   // already reported below on the transition; stay quiet rather than spam
    }
    recoveryCount += 1;
    totalRecoveries += 1;
    healthyPolls = 0;
    console.error(
      `WebRTC: restarting mediamtx to recover the dead camera source ` +
      `(attempt ${recoveryCount}/${MAX_RECOVERIES}). A restart drops any active WebRTC ` +
      `session; they are receiving no video anyway.`);
    // Reset the detector so the next window is judged fresh rather than immediately
    // re-triggering on the pre-restart byte count.
    lastBytes = null; stalledPolls = 0;
    doRestart();
    if (recoveryCount >= MAX_RECOVERIES) {
      console.error(
        `WebRTC: that was the last automatic recovery attempt. If the source dies again it ` +
        `will be REPORTED and not restarted — an endless restart loop hides a broken rover ` +
        `rather than fixing it. Investigate the encoder.`);
    }
  }

  const readerTimer = setInterval(pollReaders, READER_POLL_MS);
  if (typeof readerTimer.unref === 'function') readerTimer.unref();
  pollReaders();

  return {
    // Number of clients pulling this camera, or null when that could not be determined.
    clientCount() { return readerCount; },
    // Why the count is null, for an operator who needs to tell "nobody watching" from
    // "picar cannot see MediaMTX".
    clientCountError() { return readerPollErr; },
    // Exposed so the clamp is assertable — a bound nothing can observe is one nothing tests.
    pollIntervalMs() { return READER_POLL_MS; },
    // Whether the camera path is advertising itself as ready while producing nothing, and
    // how many automatic recoveries have been spent. Surfaced so a rover that has exhausted
    // its attempts is visible rather than quietly broken.
    sourceHealth() {
      return { dead: sourceDead, stalledPolls, notReadyPolls,
               recoveries: recoveryCount, totalRecoveries, maxRecoveries: MAX_RECOVERIES };
    },
    stop() {
      clearInterval(readerTimer);
      // Latch shutdown BEFORE clearing state. Otherwise a setVideoParams arriving
      // during teardown — which any unauthenticated socket can send, including
      // while SIGINT is being handled — would see restarting still true, queue
      // itself, and then be spawned by the dying child's close handler. That
      // launched a `systemctl restart` during process teardown, tracked by nothing.
      stopped = true;
      restartQueued = false;
      if (restartChild) { try { restartChild.kill('SIGTERM'); } catch (_) {} }
      clearRestartState();
    },

    setParams(newParams) {
      if (newParams.width      !== undefined) params.width      = newParams.width;
      if (newParams.height     !== undefined) params.height     = newParams.height;
      if (newParams.fps        !== undefined) params.fps        = newParams.fps;
      if (newParams.bitrate    !== undefined) params.bitrate    = newParams.bitrate;
      if (newParams.idr_period !== undefined) params.idr_period = newParams.idr_period;
      writeYml();

      // ASYNCHRONOUS on purpose. This used to be execSync, which blocks the Node
      // event loop for the whole duration of a systemd unit restart — seconds.
      // Everything else in this process stops during that: the Socket.IO control
      // stream, the 20 Hz RC override loop, and every fail-safe timer. So changing
      // a video slider could freeze the control path while the vehicle was armed
      // and moving. A video setting must never be able to stall C2.
      if (restarting) {
        console.log('WebRTC: mediamtx restart already in flight, coalescing');
        restartQueued = true;
        return;
      }
      restartMediamtx();
    },

    getStreamConfig() {
      return {
        codec:    'webrtc',
        protocol: PROTOCOL,
        port:     PORT,
        path:     PATH_NAME,
        width:    params.width,
        height:   params.height,
        fps:      params.fps,
        bitrate:  params.bitrate,
      };
    },
  };
};

// Exported for tests. The generated yml is the only place the ICE transport policy is
// expressed, and it reaches MediaMTX as a file rather than as an API call — so without
// this the default that decides whether video can silently fall back to TCP is
// unassertable, which is how it stayed wrong.
module.exports.generateMediaMTXConfig = generateMediaMTXConfig;
module.exports.hasHardwareEncoder = hasHardwareEncoder;
