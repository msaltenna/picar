const static = require('node-static');
const fs = require('fs');
const https = require('https');
const socketIo = require('socket.io');
const url = require('url');

const file = new static.Server();
let old_gamma = 0.14;
let old_beta = 0.14;

const pwm_min = 0.105;
const pwm_max = 0.175;
const pwm_neutral = 0.14;

const options = {
  key: fs.readFileSync('./certs/key.pem'),
  cert: fs.readFileSync('./certs/cert.pem'),
};

const server = https.createServer(options, (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  if (parsedUrl.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'OK', beta: old_beta, gamma: old_gamma }));
  } else {
    file.serve(req, res);
  }
});

const io = socketIo(server);
server.listen(8443, '0.0.0.0');
console.log('Pi Car web server listening on port 8443 — visit https://<ip>:8443/socket.html');

const { pigpio } = require('pigpio-client');
const pi = pigpio();

const throttle = pi.gpio(17);
const steering = pi.gpio(18);
throttle.modeSet('output');
steering.modeSet('output');

function setServo(gpio, pwmValue) {
  const pulse = Math.round(1000 + ((pwmValue - pwm_min) / (pwm_max - pwm_min)) * 1000);
  gpio.setServoPulsewidth(pulse, err => {
    if (err) console.error(`Failed to set servo pulse: ${err.message}`);
  });
}

function emergencyStop() {
  setServo(throttle, pwm_neutral);
  setServo(steering, pwm_neutral);
  console.log('###EMERGENCY STOP - signal lost or shutting down');
}

let smoothed_throttle = pwm_neutral;
let logcount = 0;
let lastAction = null;

io.on('connection', (socket) => {
  console.log('hello connect');
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

    if (logcount === 10) {
      logcount = 0;
      console.log(`Beta: ${data.beta} Gamma: ${data.gamma} smoothed: ${smoothed_throttle}`);
    }

    setServo(throttle, smoothed_throttle);
    setServo(steering, data.beta);

    clearInterval(lastAction);
    lastAction = setInterval(emergencyStop, 2000);
  });
});

process.on('SIGINT', function () {
  emergencyStop();
  console.log('\nGracefully shutting down from SIGINT (Ctrl-C)');
  process.exit();
});
