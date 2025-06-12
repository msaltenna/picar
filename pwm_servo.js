// pwm_servo.js

module.exports = function PWMDriver(config) {
  if (config.pwm_method === 'sysfs') {
    const PWMServoSysFS = require('./pwm_sysfs_servo');
    return new PWMServoSysFS(config);
  } else if (config.pwm_method === 'libgpiod') {
    const PWMServoGPIOD = require('./pwm_libgpiod_servo');
    return new PWMServoGPIOD(config);
  } else {
    throw new Error(`Unsupported PWM driver: ${config.pwm_driver}`);
  }
};
