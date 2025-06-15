// pwm_servo.js

function PWMDriver(config) {
  try {
    const method = config.pwm_method; // e.g., 'sysfs', 'libgpiod', or 'pigpiod'
    const Module = require(`./pwm_${method}_servo.js`);
    return new Module(config);
  } catch (err) {
    console.error(`Failed to load PWM driver for method "${config.pwm_method}": ${err.message}`);
    process.exit(1);
  }
}

module.exports = PWMDriver;

