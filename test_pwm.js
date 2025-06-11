// test_pwm.js
const pwm = require('./pwm_servo');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sweep(id, label) {
  console.log(`Sweeping ${label} (id=${id})...`);

  for (let v = -1; v <= 1.01; v += 0.1) {
    pwm.setServoPWM(id, v);
    console.log(`${label}: ${v.toFixed(1)}`);
    await sleep(200);
  }

  for (let v = 1; v >= -1.01; v -= 0.1) {
    pwm.setServoPWM(id, v);
    console.log(`${label}: ${v.toFixed(1)}`);
    await sleep(200);
  }

  pwm.setServoPWM(id, 0);
  console.log(`${label} centered.\n`);
}

async function main() {
  console.log('--- PWM Servo Test ---');
  await sweep(0, 'Steering');
  await sweep(1, 'Throttle');
}

main().catch(console.error);

