// streams/h264.js — H264 Annex-B over WebSocket (wss://host:8081/stream)
'use strict';

const { spawn, execSync } = require('child_process');
const { WebSocket, WebSocketServer } = require('ws');

// ── NAL-unit parser (Annex-B start-code framing) ─────────────────────────────
//
// Groups raw bytes from rpicam-vid/libcamera-vid into complete access units:
//   Keyframe packet : SPS(7) + PPS(8) + [SEI/AUD] + IDR-slice(5)
//   Delta packet    : [SEI/AUD] + non-IDR-slice(1)
//
// WebCodecs EncodedVideoChunk for a 'key' frame must include the SPS+PPS so
// the decoder can (re)configure itself — hence the grouping.
// A single access unit at 640x480/600 kbps is a few KB; 4 MB means something is
// badly wrong, so resync rather than grow without bound.
const MAX_NAL_BUFFER = 4 * 1024 * 1024;

class NalParser {
  constructor(onPacket) {
    this.buf      = Buffer.alloc(0);
    this.pending  = [];
    this.scanned  = 0;
    this.onPacket = onPacket;
  }

  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    // Bound the buffer. Without this, a camera producing bytes that never contain
    // a second start code (a wedged encoder, or a stream we fail to parse) grows
    // this buffer without limit until the process dies. Dropping back to a
    // resync is always recoverable — the next keyframe restores the picture.
    if (this.buf.length > MAX_NAL_BUFFER) {
      console.error(`H264: NAL buffer exceeded ${MAX_NAL_BUFFER} bytes — resyncing`);
      this.reset();
      return;
    }
    while (this._extractOne()) { /* drain */ }
  }

  reset() { this.buf = Buffer.alloc(0); this.pending = []; this.scanned = 0; }

  _findSC(from) {
    const b = this.buf;
    for (let i = from; i < b.length - 2; i++) {
      if (b[i] !== 0 || b[i + 1] !== 0) continue;
      if (b[i + 2] === 1)                               return { pos: i, len: 3 };
      if (i + 3 < b.length && b[i + 2] === 0 && b[i + 3] === 1) return { pos: i, len: 4 };
    }
    return null;
  }

  _extractOne() {
    // `scanned` remembers how far we already searched without finding a second
    // start code, so a partially-received NAL is not rescanned from byte 0 on
    // every chunk. That rescan made this O(n^2) in the size of an access unit,
    // on the per-frame hot path.
    const sc1 = this._findSC(0);
    if (!sc1) {
      // No start code yet. KEEP the trailing 3 bytes: a 4-byte start code can
      // straddle a chunk boundary, and discarding the whole buffer here — which
      // is what this did — threw those bytes away and corrupted the framing of
      // the next access unit. Three is the most that can be pending, since a
      // 4-byte start code with its last byte still unreceived is 3 bytes long.
      if (this.buf.length > 3) this.buf = this.buf.subarray(this.buf.length - 3);
      this.scanned = 0;
      return false;
    }

    const nalStart = sc1.pos + sc1.len;
    const resumeAt = Math.max(nalStart + 1, this.scanned);
    const sc2      = this._findSC(resumeAt);
    if (!sc2) {
      if (sc1.pos > 0) {
        this.buf = this.buf.slice(sc1.pos);
        // Keep `scanned` relative to the new buffer start, minus the 3-byte
        // overlap a start code could straddle.
        this.scanned = Math.max(0, this.buf.length - 3);
      } else {
        this.scanned = Math.max(0, this.buf.length - 3);
      }
      return false;
    }

    const rawNal  = this.buf.slice(sc1.pos, sc2.pos);
    const nalType = this.buf[nalStart] & 0x1f;
    this.buf = this.buf.slice(sc2.pos);
    this.scanned = 0;

    switch (nalType) {
      case 7:  // SPS
      case 8:  // PPS
      case 6:  // SEI
      case 9:  // AUD
        this.pending.push(rawNal);
        break;
      case 5:  // IDR slice → keyframe
        this.pending.push(rawNal);
        this.onPacket(Buffer.concat(this.pending), true);
        this.pending = [];
        break;
      case 1:  // non-IDR slice → delta frame
        {
          const all = [...this.pending, rawNal];
          this.pending = [];
          this.onPacket(Buffer.concat(all), false);
        }
        break;
      default:
        this.pending.push(rawNal);
    }
    return true;
  }
}

// Whether a frame is worth sending to a client with `backlog` bytes still queued.
//
// Keyframes survive a delta-level backlog because dropping them leaves the client
// unable to resync at all; only a hard backlog drops everything. Named and
// exported so the rule itself is testable — a copy of it in a test would not
// catch an inverted comparison here.
function shouldSendFrame(isKeyframe, backlog, dropDeltaBytes, dropAllBytes) {
  if (backlog > dropAllBytes) return false;
  if (!isKeyframe && backlog > dropDeltaBytes) return false;
  return true;
}

// ── Module factory ────────────────────────────────────────────────────────────
function createH264Stream(config, streamServer) {
  let WIDTH   = config.h264_width        || 640;
  let HEIGHT  = config.h264_height       || 480;
  let FPS     = config.h264_framerate    || 30;
  let BITRATE = (config.h264_bitrate_kbps || 600) * 1000;
  let INTRA   = config.h264_intra_period || 15;

  // Detect rpicam-vid (Pi 5+) or libcamera-vid (Pi 4)
  let cameraCmd = null;
  for (const cmd of ['rpicam-vid', 'libcamera-vid']) {
    try { execSync(`which ${cmd}`, { stdio: 'ignore' }); cameraCmd = cmd; break; }
    catch (_) {}
  }
  if (!cameraCmd) console.error('H264: neither rpicam-vid nor libcamera-vid found');
  console.log(`H264 camera command: ${cameraCmd || '(none found)'}`);

  // ── WebSocket state ───────────────────────────────────────────────────────
  // New connections go to wsPending until they receive their first IDR keyframe.
  // This prevents WebCodecs from seeing a delta frame before any key frame.
  const wsClients = new Set();
  const wsPending = new Set();
  let frameCount    = 0;
  let cameraProc    = null;
  let droppedFrames = 0;
  let lastDropLog   = 0;

  // Latency budget expressed in queued bytes, because that is what a WebSocket
  // can actually report. At the default 600 kbps (~75 kB/s) these correspond to
  // roughly 0.65 s and 2.7 s of backlog. Configurable so a rover on a poor link
  // can be tuned without a code change.
  const DROP_DELTA_BYTES = config.h264_drop_delta_bytes ?? 48 * 1024;
  const DROP_ALL_BYTES   = config.h264_drop_all_bytes   ?? 200 * 1024;

  function clientCount() { return wsClients.size + wsPending.size; }

  // Report drops periodically. A silent drop is indistinguishable from a stall,
  // and the whole point of this change is that the operator can tell the
  // difference between "the link is slow" and "the stream is broken".
  function logDropsIfDue() {
    if (droppedFrames === 0) return;
    const now = Date.now();
    if (now - lastDropLog < 5000) return;
    lastDropLog = now;
    console.log(`H264: dropped ${droppedFrames} stale frame(s) to bound latency`);
    droppedFrames = 0;
  }

  function broadcast(data, isKeyframe) {
    if (!wsClients.size && !wsPending.size) return;
    const hdr = Buffer.allocUnsafe(5);
    hdr[0] = isKeyframe ? 0x01 : 0x00;
    hdr.writeUInt32BE(frameCount, 1);
    frameCount = (frameCount + 1) >>> 0;
    const pkt = Buffer.concat([hdr, data]);

    for (const ws of wsClients) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      // ── Drop stale frames rather than queueing them ────────────────────────
      //
      // Previously every frame was handed to ws.send() with no regard for
      // whether the socket could absorb it. On a link slower than the encoder,
      // ws.bufferedAmount grows without bound: the client falls further and
      // further behind real time, latency rises monotonically, and the server's
      // memory grows with it. For teleoperation a late frame is worthless — the
      // operator needs to see *now*, not a faithful replay of ten seconds ago.
      //
      // So when a client is backed up we drop delta frames for it and let the
      // next keyframe resynchronise the picture. Keyframes are still allowed
      // through a moderate backlog, because dropping them means the client
      // cannot recover at all; only a hard backlog drops everything.
      if (!shouldSendFrame(isKeyframe, ws.bufferedAmount, DROP_DELTA_BYTES, DROP_ALL_BYTES)) {
        droppedFrames++;
        continue;
      }

      try { ws.send(pkt, { binary: true }); }
      catch (_) { wsClients.delete(ws); }
    }

    logDropsIfDue();

    if (isKeyframe && wsPending.size) {
      for (const ws of wsPending) {
        wsPending.delete(ws);
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(pkt, { binary: true }); wsClients.add(ws); }
          catch (_) {}
        }
      }
    }
  }

  // ── Camera lifecycle ──────────────────────────────────────────────────────
  function stop() {
    if (cameraProc) { cameraProc.kill('SIGTERM'); cameraProc = null; }
  }

  function start() {
    if (cameraProc) return;
    if (!cameraCmd) { console.error('H264: no camera command available'); return; }

    let gotFirst = false;
    // --profile baseline: no B-frames; --intra N: IDR every N frames (~0.5 s at
    // 30 fps) so freeze after packet loss is bounded; --bitrate CBR keeps IDR
    // size predictable (≤ ~8 KB at 600 kbps → < 130 ms on air).
    const args = [
      '--codec',     'h264',
      '--width',     String(WIDTH),
      '--height',    String(HEIGHT),
      '--framerate', String(FPS),
      '--bitrate',   String(BITRATE),
      '--intra',     String(INTRA),
      '--profile',   'baseline',
      '--nopreview',
      '-t', '0',
      '-o', '-',
    ];

    console.log(`H264 starting ${WIDTH}×${HEIGHT}@${FPS}fps ${BITRATE/1000}kbps intra=${INTRA}`);
    cameraProc = spawn(cameraCmd, args);

    const parser = new NalParser((data, isKey) => broadcast(data, isKey));

    cameraProc.stdout.on('data', (chunk) => {
      if (!gotFirst) { gotFirst = true; console.log('H264: stream live'); }
      parser.push(chunk);
    });

    cameraProc.stderr.on('data', (d) => console.log('H264 camera:', d.toString().trim()));

    cameraProc.on('close', (code) => {
      console.log(`H264 camera exited (code ${code})`);
      cameraProc = null;
      parser.reset();
      if (clientCount() > 0) {
        const delay = gotFirst ? 1000 : 5000;
        console.log(`H264: restarting in ${delay} ms…`);
        setTimeout(start, delay);
      }
    });

    cameraProc.on('error', (e) => {
      console.error('H264 camera spawn error:', e.message);
      cameraProc = null;
    });
  }

  // Force a new SPS+PPS+IDR by restarting the encoder.
  // Rate-limited by the caller to once per 5 s.
  function forceKeyframe() {
    if (!cameraProc) return;
    console.log('H264: forcing keyframe — restarting encoder');
    stop();
    setTimeout(start, 250);
  }

  // ── WebSocket endpoint ────────────────────────────────────────────────────
  const wss = new WebSocketServer({ server: streamServer, path: '/stream' });

  wss.on('connection', (ws) => {
    wsPending.add(ws);
    console.log(`H264 WS client connected (pending keyframe)`);

    ws.on('message', (msg) => {
      try {
        const d = JSON.parse(msg);
        if (d.type === 'requestKeyframe') {
          const now = Date.now();
          if (!wss._lastKfForce || now - wss._lastKfForce > 5000) {
            wss._lastKfForce = now;
            forceKeyframe();
          }
        }
      } catch (_) {}
    });

    ws.on('close', () => {
      wsPending.delete(ws);
      wsClients.delete(ws);
      console.log(`H264 WS disconnected (${wsClients.size} active, ${wsPending.size} pending)`);
      if (clientCount() === 0) stop();
    });

    ws.on('error', (e) => {
      console.error('H264 WS error:', e.message);
      wsPending.delete(ws);
      wsClients.delete(ws);
    });

    start();
  });

  return {
    clientCount,
    stop,
    setParams(params) {
      if (params.width   !== undefined) WIDTH   = params.width;
      if (params.height  !== undefined) HEIGHT  = params.height;
      if (params.fps     !== undefined) FPS     = params.fps;
      if (params.bitrate !== undefined) BITRATE = params.bitrate * 1000;
      stop();
      if (clientCount() > 0) setTimeout(start, 500);
    },
    getStreamConfig() {
      return { codec: 'avc1.42001f', width: WIDTH, height: HEIGHT, fps: FPS, bitrate: Math.round(BITRATE / 1000) };
    },
  };
};

module.exports = createH264Stream;
// Exported for tests: the framing parser and the frame-drop rule are the two
// pieces most likely to regress silently, so they are exercised directly rather
// than through a reimplementation.
module.exports.NalParser = NalParser;
module.exports.shouldSendFrame = shouldSendFrame;
module.exports.MAX_NAL_BUFFER = MAX_NAL_BUFFER;

