// pwm_servo.js
// Adapter to load the appropriate PWM control backend based on config

const fs = require('fs');
const path = require('path');

// Load config
const configPath = path.join(__dirname, 'picar-cfg.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath));
} catch (err) {
  console.error(`Failed to read config file at ${configPath}:`, err);
  process.exit(1);
}

let PWMDriver;
if (config.pwm_method === 'libgpiod') {
  PWMDriver = require('./pwm_libgpiod_servo');
} else if (config.pwm_method === 'sysfs') {
  PWMDriver = require('./pwm_sysfs_servo');
} else {
  console.error(`Unsupported pwm_method: '${config.pwm_method}'`);
  process.exit(1);
}

const pwm = new PWMDriver(config);

module.exports = pwm;

