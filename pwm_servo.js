// pwm_servo.js
const fs = require('fs');
const path = require('path');

let PWMDriver;
if (config.pwm_method === 'libgpiod') {
  PWMDriver = require('./pwm_libgpiod_servo');
} else if (config.pwm_method === 'sysfs') {
  PWMDriver = require('./pwm_sysfs_servo');
} else {
  console.error(`Unsupported pwm_method: '${config.pwm_method}'`);
  process.exit(1);
}

module.exports = {
  PWMDriver
};

