// streams/mjpeg.js — MJPEG multipart stream over HTTPS (https://host:8081/stream.mjpg)
'use strict';

const { spawn, execSync } = require('child_process');

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END   = Buffer.from([0xff, 0xd9]);

// Skip a frame for a client that has not drained the previous ones. Exported so
// the rule is tested directly rather than reimplemented in a test.
function shouldSkipFrame(writableLength, dropBytes) {
  return writableLength > dropBytes;
}

function createMjpegStream(config, streamServer) {
  let WIDTH   = config.mjpeg_width     || 480;
  let HEIGHT  = config.mjpeg_height    || 360;
  let FPS     = config.mjpeg_framerate || 12;
  let QUALITY = config.mjpeg_quality   || 20;

  let cameraCmd = null;
  for (const cmd of ['rpicam-vid', 'libcamera-vid']) {
    try { execSync(`which ${cmd}`, { stdio: 'ignore' }); cameraCmd = cmd; break; }
    catch (_) {}
  }
  if (!cameraCmd) console.error('MJPEG: neither rpicam-vid nor libcamera-vid found');
  console.log(`MJPEG camera command: ${cameraCmd || '(none found)'}`);

  let clients    = [];   // HTTP response objects
  let cameraProc    = null;
  let jpegBuf       = Buffer.alloc(0);
  let droppedFrames = 0;
  let lastDropLog   = 0;

  // One 480x360 JPEG at quality 20 is roughly 15-25 kB, so this is about two
  // frames of slack before we start dropping.
  const DROP_BYTES = config.mjpeg_drop_bytes ?? 64 * 1024;
  // A wedged camera that never emits an end-of-image marker would otherwise grow
  // jpegBuf without limit.
  const MAX_JPEG_BUFFER = config.mjpeg_max_buffer_bytes ?? 4 * 1024 * 1024;

  function clientCount() { return clients.length; }

  function broadcast(frame) {
    const hdr = `--ffserver\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
    for (let i = clients.length - 1; i >= 0; i--) {
      const c = clients[i];
      if (c.writableEnded) { clients.splice(i, 1); continue; }

      // Drop this frame for any client that has not drained the previous ones.
      //
      // MJPEG sends a whole independently-decodable image per frame, so a
      // dropped frame costs nothing but smoothness — there is no keyframe
      // dependency to break. Previously every frame was written regardless, so a
      // client slower than the camera accumulated unbounded backlog in Node's
      // socket buffer: latency grew without limit and the server's memory grew
      // with it. For teleoperation the newest frame is the only useful one.
      if (shouldSkipFrame(c.writableLength, DROP_BYTES)) {
        droppedFrames++;
        continue;
      }

      try {
        c.write(hdr);
        c.write(frame);
        c.write('\r\n');
      } catch (_) { clients.splice(i, 1); }
    }
    logDropsIfDue();
  }

  // A silent drop looks exactly like a stall to whoever is debugging it.
  function logDropsIfDue() {
    if (droppedFrames === 0) return;
    const now = Date.now();
    if (now - lastDropLog < 5000) return;
    lastDropLog = now;
    console.log(`MJPEG: dropped ${droppedFrames} stale frame(s) to bound latency`);
    droppedFrames = 0;
  }

  function stop() {
    if (cameraProc) { cameraProc.kill('SIGTERM'); cameraProc = null; }
    jpegBuf = Buffer.alloc(0);
  }

  function start() {
    if (cameraProc) return;
    if (!cameraCmd) { console.error('MJPEG: no camera command available'); return; }

    let gotFirst = false;
    jpegBuf = Buffer.alloc(0);

    const args = [
      '--codec',     'mjpeg',
      '--width',     String(WIDTH),
      '--height',    String(HEIGHT),
      '--framerate', String(FPS),
      '--quality',   String(QUALITY),
      '--nopreview',
      '-t', '0',
      '-o', '-',
    ];

    console.log(`MJPEG starting ${WIDTH}×${HEIGHT}@${FPS}fps quality=${QUALITY}`);
    cameraProc = spawn(cameraCmd, args);

    cameraProc.stdout.on('data', (chunk) => {
      if (!gotFirst) { gotFirst = true; console.log('MJPEG: stream live'); }
      jpegBuf = jpegBuf.length === 0 ? chunk : Buffer.concat([jpegBuf, chunk]);
      if (jpegBuf.length > MAX_JPEG_BUFFER) {
        console.error(`MJPEG: buffer exceeded ${MAX_JPEG_BUFFER} bytes — resyncing`);
        jpegBuf = Buffer.alloc(0);
        return;
      }
      while (true) {
        const s = jpegBuf.indexOf(JPEG_START);
        if (s === -1) { jpegBuf = Buffer.alloc(0); break; }
        if (s > 0) jpegBuf = jpegBuf.subarray(s);
        const e = jpegBuf.indexOf(JPEG_END, 2);
        if (e === -1) break;
        broadcast(jpegBuf.subarray(0, e + 2));
        jpegBuf = jpegBuf.subarray(e + 2);
      }
    });

    cameraProc.stderr.on('data', (d) => console.log('MJPEG camera:', d.toString().trim()));

    cameraProc.on('close', (code) => {
      console.log(`MJPEG camera exited (code ${code})`);
      cameraProc = null;
      jpegBuf = Buffer.alloc(0);
      if (clientCount() > 0) {
        const delay = gotFirst ? 1000 : 5000;
        console.log(`MJPEG: restarting in ${delay} ms…`);
        setTimeout(start, delay);
      }
    });

    cameraProc.on('error', (e) => {
      console.error('MJPEG camera spawn error:', e.message);
      cameraProc = null;
    });
  }

  // ── HTTP multipart endpoint ───────────────────────────────────────────────
  streamServer.on('request', (req, res) => {
    if (req.url !== '/stream.mjpg') return;
    res.writeHead(200, {
      'Content-Type':  'multipart/x-mixed-replace; boundary=ffserver',
      'Cache-Control': 'no-cache',
      'Connection':    'close',
      'Pragma':        'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    clients.push(res);
    console.log(`MJPEG client connected (${clients.length} total)`);
    req.on('close', () => {
      clients = clients.filter(c => c !== res);
      console.log(`MJPEG client disconnected (${clients.length} remaining)`);
      if (clientCount() === 0) stop();
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
      if (params.quality !== undefined) QUALITY = params.quality;
      stop();
      if (clientCount() > 0) setTimeout(start, 500);
    },
    getStreamConfig() {
      return { codec: 'mjpeg', width: WIDTH, height: HEIGHT, fps: FPS, quality: QUALITY };
    },
  };
};

module.exports = createMjpegStream;
module.exports.shouldSkipFrame = shouldSkipFrame;
