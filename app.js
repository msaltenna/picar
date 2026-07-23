// app.js
const fs            = require('fs');
const https         = require('https');
const { Server }    = require('socket.io');
const url           = require('url');
const static        = require('node-static');
const path          = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const configPath = path.join(__dirname, 'picar-cfg.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath));
} catch (err) {
  console.error(`Failed to read config file at ${configPath}:`, err);
  process.exit(1);
}

// Per-rover overrides live in picar-cfg.local.json (untracked; written by
// install.sh). Keeping machine-specific values like rover_id out of version
// control means the tracked picar-cfg.json can be updated / git-pulled without
// clobbering each rover's identity. Keys here shallow-override the tracked ones.
const localConfigPath = path.join(__dirname, 'picar-cfg.local.json');
if (fs.existsSync(localConfigPath)) {
  try {
    Object.assign(config, JSON.parse(fs.readFileSync(localConfigPath)));
    console.log(`Applied local overrides from ${localConfigPath}`);
  } catch (err) {
    console.error(`Failed to read local config at ${localConfigPath}:`, err);
    process.exit(1);
  }
}
console.log(`Rover ID: ${config.rover_id ?? 1}`);

const PWMDriver = require('./pwm_servo');
const pwm = PWMDriver(config);
const ControlSafetyController = require('./control-safety');
const control = new ControlSafetyController(pwm, config);

require('./fleetmgr-client').start(config);

const file = new static.Server();
const options = {
  key:  fs.readFileSync('./certs/key.pem'),
  cert: fs.readFileSync('./certs/cert.pem'),
};

// ── Video stream server (port 8081) ───────────────────────────────────────────
// Stream modules attach their request/WebSocket handlers first (inside createStream),
// then a fallback listener handles everything else as the cert-acceptance page.
const streamServer = https.createServer(options);

const createStream = require('./streams');
const stream = createStream(config, streamServer);
console.log(`Stream codec: ${(config.stream_codec || 'h264').toLowerCase()}`);

// Fallback: cert-acceptance landing page for any request not handled by the stream module
streamServer.on('request', (req, res) => {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
  res.end(`<!DOCTYPE html><html><body style="background:#111;color:#0f0;font-family:sans-serif;\
display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
    <div style="text-align:center">
      <h2>Stream Server Ready</h2>
      <p>Certificate accepted. You can close this tab.</p>
      <script>
        if (window.opener) window.opener.postMessage('stream-cert-ok', '*');
        setTimeout(() => window.close(), 1500);
      </script>
    </div>
  </body></html>`);
});

streamServer.listen(8081, '0.0.0.0');
console.log(`Video stream server: https://<ip>:8081`);

// ── Web UI + control server (port 8443) ───────────────────────────────────────
const appServer = https.createServer(options, (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'OK', ...control.getStatus() }));
  } else if (parsed.pathname === '/manifest.json') {
    const roverId = config.rover_id ?? 1;
    const manifest = {
      name:             `PiCar Rover ${roverId}`,
      short_name:       `Rover ${roverId}`,
      start_url:        '/socket.html',
      display:          'fullscreen',
      orientation:      'landscape',
      background_color: '#000000',
      theme_color:      '#000000',
      icons: [
        { src: `/icons/rover${roverId}-192.png`, sizes: '192x192', type: 'image/png' },
        { src: `/icons/rover${roverId}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    };
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(JSON.stringify(manifest));
  } else {
    file.serve(req, res);
  }
});

const io = new Server(appServer);
control.onFailSafe = ({ reason, socketId }) => {
  const ownerSocket = io.sockets.sockets.get(socketId);
  if (ownerSocket) ownerSocket.emit('controlStopped', { reason });
};
appServer.listen(8443, '0.0.0.0');
console.log('Pi Car web server: https://<ip>:8443/socket.html');

io.on('connection', (socket) => {
  console.log(`Control client connected: ${socket.id}`);

  // Push stream config so the client sets up the right decoder
  socket.emit('streamConfig', stream.getStreamConfig());

  socket.on('arm', (request, acknowledge) => {
    const result = control.arm(socket.id, request);
    if (typeof acknowledge === 'function') acknowledge(result);
  });

  socket.on('disarm', (request, acknowledge) => {
    const result = control.disarm(socket.id, request);
    if (typeof acknowledge === 'function') acknowledge(result);
  });

  socket.on('setVideoParams', (params) => {
    console.log('setVideoParams:', params);
    stream.setParams(params);
    // Re-broadcast updated config to all connected clients
    setTimeout(() => io.emit('streamConfig', stream.getStreamConfig()), 600);
  });

  socket.on('fromclient', (data) => {
    control.handleCommand(socket.id, data);
  });

  socket.on('disconnect', () => {
    console.log(`Control client disconnected: ${socket.id}`);
    control.disconnect(socket.id);
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  control.shutdown();
  stream.stop();
  console.log(`\nShutting down (${signal})`);
  // Give the final neutral + DISARM packet a brief chance to flush to
  // MAVProxy before systemd terminates the process.
  setTimeout(() => process.exit(), 100);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
