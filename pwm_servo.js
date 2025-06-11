// pwm_servo.js
const fs = require('fs');
const path = require('path');

function writeSyncSafe(filePath, value) {
  try {
    fs.writeFileSync(filePath, value.toString());
  } catch (err) {
    console.error(`Failed to write ${value} to ${filePath}:`, err.message);
  }
}

function enablePWM(channel) {
  const basePath = `/sys/class/pwm/pwmchip0`;
  const pwmPath = path.join(basePath, `pwm${channel}`);
  if (!fs.existsSync(pwmPath)) {
    writeSyncSafe(path.join(basePath, 'export'), channel);
  }
  return pwmPath;
}

function setServoPWM(channel, pwmValue) {
  const pwmPath = enablePWM(channel);
  const period = 20000000; // 20ms in ns
  const pulse = Math.round(1000000 + ((pwmValue - 0.105) / (0.175 - 0.105)) * 1000000);
  writeSyncSafe(path.join(pwmPath, 'period'), period);
  writeSyncSafe(path.join(pwmPath, 'duty_cycle'), pulse);
  writeSyncSafe(path.join(pwmPath, 'enable'), 1);
}

module.exports = { setServoPWM };
