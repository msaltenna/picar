// app.js
const fs = require('fs');
const https = require('https');
const { Server } = require('socket.io');
const url = require('url');
const static = require('node-static');
const { spawn } = require('child_process');

const path = require('path');
const configPath = path.join(__dirname, 'picar-cfg.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath));
} catch (err) {
  console.error(`Failed to read config file at ${configPath}:`, err);
  process.exit(1);
}

const { PWMDriver } = require('./pwm_servo');
const pwm = new PWMDriver(config);

const file = new static.Server();
const options = {
  key: fs.readFileSync('./certs/key.pem'),
  cert: fs.readFileSync('./certs/cert.pem'),
};

// Web UI + Socket Server (port 8443)
const appServer = https.createServer(options, (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  if (parsedUrl.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'OK', beta: old_beta, gamma: old_gamma }));
  } else {
    file.serve(req, res);
  }
});

const io = new Server(appServer);
appServer.listen(8443, '0.0.0.0');
console.log('Pi Car web server listening on https://<ip>:8443/socket.html');

let old_beta = 0.14;
let old_gamma = 0.14;
const pwm_neutral = config.pwm_neutral;
let smoothed_throttle = pwm_neutral;
let logcount = 0;
let lastAction = null;

io.on('connection', (socket) => {
  console.log('Socket connected');
  socket.on('fromclient', (data) => {
    logcount++;
    old_beta = data.beta;
    old_gamma = data.gamma;

    if (data.gamma > pwm_neutral && data.gamma > smoothed_throttle) {
      if (smoothed_throttle < pwm_neutral) smoothed_throttle = pwm_neutral;
      smoothed_throttle += 0.001;
    } else if (data.gamma < pwm_neutral && data.gamma < smoothed_throttle) {
      if (smoothed_throttle > pwm_neutral) smoothed_throttle = pwm_neutral;
      smoothed_throttle -= 0.0003;
    } else {
      smoothed_throttle = data.gamma;
    }

    if (logcount === 10) logcount = 0;

    pwm.setServoPWM('throttle', smoothed_throttle); // PWM0 for throttle
    pwm.setServoPWM('steering', data.beta);         // PWM1 for steering

    clearInterval(lastAction);
    lastAction = setInterval(() => {
      pwm.setServoPWM('throttle', pwm_neutral);
      pwm.setServoPWM('steering', pwm_neutral);
      console.log('### EMERGENCY STOP');
    }, 2000);
  });
});

process.on('SIGINT', function () {
  pwm.setServoPWM('throttle', pwm_neutral);
  pwm.setServoPWM('steering', pwm_neutral);
  console.log('\nGracefully shutting down from SIGINT');
  process.exit();
});

// MJPEG Stream Server (port 8081)
const streamServer = https.createServer(options, (req, res) => {
  if (req.url === '/stream.mjpg') {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=ffserver',
      'Cache-Control': 'no-cache',
      'Connection': 'close',
      'Pragma': 'no-cache',
    });

    const ffmpeg = spawn('ffmpeg', [
      '-f', 'v4l2',
      '-framerate', '15',
      '-video_size', '640x480',
      '-i', '/dev/video0',
      '-fflags', 'nobuffer',
      '-f', 'mjpeg',
      'pipe:1'
    ]);

    ffmpeg.stdout.on('data', (chunk) => {
      //console.log(`Sent frame of ${chunk.length} bytes`);
      res.write(`--ffserver\r\nContent-Type: image/jpeg\r\nContent-Length: ${chunk.length}\r\n\r\n`);
      res.write(chunk);
      res.write('\r\n');
    });

    //ffmpeg.stderr.on('data', data => {
    //  console.error(`[ffmpeg] ${data}`);
    //});

    //ffmpeg.stdout.pipe(res);

    req.on('close', () => {
      ffmpeg.kill('SIGTERM');
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

streamServer.listen(8081, '0.0.0.0');
console.log('MJPEG stream available at https://<ip>:8081/stream.mjpg');

