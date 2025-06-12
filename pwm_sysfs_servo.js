// pwm_sysfs_servo.js
// PWM control using legacy sysfs interface

const fs = require('fs');
const path = require('path');

class PWMServoSYSFS {
  constructor(config) {
    this.steeringPin = config.steering_gpio;
    this.throttlePin = config.throttle_gpio;
    this.period = config.pwm_period_us * 1000; // convert to ns
    this.min = config.pwm_min_us * 1000;
    this.max = config.pwm_max_us * 1000;

    this.paths = {
      [this.steeringPin]: `/sys/class/pwm/pwmchip0/pwm0`,
      [this.throttlePin]: `/sys/class/pwm/pwmchip0/pwm1`,
    };

    this.initPWM(this.steeringPin);
    this.initPWM(this.throttlePin);
  }

  initPWM(pin) {
    const base = this.paths[pin];
    try {
      if (!fs.existsSync(base)) {
        fs.writeFileSync(`/sys/class/pwm/pwmchip0/export`, pin === this.steeringPin ? '0' : '1');
      }
      fs.writeFileSync(path.join(base, 'period'), this.period.toString());
      fs.writeFileSync(path.join(base, 'enable'), '1');
    } catch (err) {
      console.error(`Failed to initialize PWM on pin ${pin}:`, err.message);
    }
  }

  scale(value) {
    const clamped = Math.max(-1, Math.min(1, value));
    const mid = (this.min + this.max) / 2;
    const range = (this.max - this.min) / 2;
    return Math.round(mid + clamped * range);
  }

  writeDutyCycle(pin, value) {
    const base = this.paths[pin];
    try {
      fs.writeFileSync(path.join(base, 'duty_cycle'), value.toString());
    } catch (err) {
      console.error(`Failed to write duty cycle for pin ${pin}:`, err.message);
    }
  }

  setSteering(value) {
    const pulse = this.scale(value);
    this.writeDutyCycle(this.steeringPin, pulse);
  }

  setThrottle(value) {
    const pulse = this.scale(value);
    this.writeDutyCycle(this.throttlePin, pulse);
  }

  setServoPWM(name, value) {
    if (name === 'steering') {
      this.setSteering(value);
    } else if (name === 'throttle') {
      this.setThrottle(value);
    } else {
      console.warn(`Invalid servo name: ${name}`);
    }
  }
}

module.exports = PWMServoSYSFS;

