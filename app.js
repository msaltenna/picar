// Required modules
const http = require('http');
const { pigpio } = require('pigpio-client');
const fs = require('fs');
const static = require('node-static');
const url = require('url');

// Load PWM config from config.json
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const { pwm_min, pwm_max, pwm_neutral } = config;

// Static file server
const file = new static.Server();

// Create HTTP + WebSocket server
const app = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'OK', beta: old_beta, gamma: old_gamma }));
  } else {
    file.serve(req, res);
  }
});

const io = require('socket.io')(app);
app.listen(8080);
console.log('Pi Car web server listening on port 8080 visit http://<ip>:8080/socket.html');

// Connect to pigpiod
const pi = pigpio({ host: 'localhost' });
const throttle = pi.gpio(17);
const steering = pi.gpio(18);

throttle.modeSet('output');
steering.modeSet('output');

function setServo(pin, pwmValue) {
  const duty = Math.round((pwmValue - pwm_min) * (255 / (pwm_max - pwm_min)));
  pin.pwmWrite(Math.min(255, Math.max(0, duty)));
}

let smoothed_throttle = pwm_neutral;
let logcount = 0;
let old_gamma = pwm_neutral;
let old_beta = pwm_neutral;
let lastAction = null;

function emergencyStop() {
  setServo(throttle, pwm_neutral);
  setServo(steering, pwm_neutral);
  console.log('###EMERGENCY STOP - signal lost or shutting down');
}

io.on('connection', (socket) => {
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
