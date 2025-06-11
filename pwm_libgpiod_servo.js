// pwm_libgpiod_servo.js
// Replacement for sysfs-based PWM using libgpiod (via gpiod CLI)

const { execSync } = require('child_process');

class PWMServoGPIOD {
  constructor(config) {
    this.chip = 'gpiochip0'; // Correct for GPIO18/19 on RPi 5
    this.pins = {
      steering: config.steering_gpio,
      throttle: config.throttle_gpio,
    };
    this.period_us = config.pwm_period_us;
    this.min_us = config.pwm_min_us;
    this.max_us = config.pwm_max_us;

    this.lastPWM = {
      0: 0,
      1: 0,
    };

    this.running = {
      0: false,
      1: false,
    };

    this.intervals = {
      0: null,
      1: null,
    };

    this.enablePWM(this.pins.steering);
    this.enablePWM(this.pins.throttle);
  }

  enablePWM(pin) {
    console.log(`Configured pin ${pin} for software PWM using libgpiod.`);
  }

  scale(value) {
    const clamped = Math.max(-1, Math.min(1, value));
    const mid = (this.min_us + this.max_us) / 2;
    const range = (this.max_us - this.min_us) / 2;
    return Math.round(mid + clamped * range);
  }

  pulse(pin, pulseWidthUs) {
    const chip = this.chip;
    const period = this.period_us;
    try {
      execSync(`gpioset -m time -u ${pulseWidthUs} ${chip} ${pin}=1`);
    } catch (err) {
      console.error(`Failed to pulse pin ${pin}: ${err.message}`);
    }
  }

  startPWM(id, pin) {
    if (this.running[id]) return;
    this.running[id] = true;
    this.intervals[id] = setInterval(() => {
      this.pulse(pin, this.scale(this.lastPWM[id]));
    }, this.period_us / 1000);
  }

  setServoPWM(id, value) {
    if (!(id in this.pins)) {
      console.warn(`Invalid servo id: ${id}`);
      return;
    }
    this.lastPWM[id] = value;
    this.startPWM(id, this.pins[id]);
  }
}

module.exports = PWMServoGPIOD;

