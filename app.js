<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="user-scalable=no, initial-scale=1.0, maximum-scale=1.0;">
  <title>PiCar Controller</title>
  <script src="/socket.io/socket.io.js"></script>
  <script>
    let socket;
    let beta = 0.14;
    let gamma = 0.14;
    let intervalId;

    const maxbeta = 0.175;
    const minbeta = 0.105;
    const maxgamma = 0.175;
    const mingamma = 0.105;

    function sendToPi() {
      socket.emit('fromclient', { beta, gamma });
      document.getElementById('betaVal').textContent = beta.toFixed(3);
      document.getElementById('gammaVal').textContent = gamma.toFixed(3);
    }

    function handleOrientation(event) {
      let tmp_beta = 0.001167 * event.beta + 0.14;
      tmp_beta = Math.min(Math.max(tmp_beta, minbeta), maxbeta);
      beta = tmp_beta;

      let tmp_gamma = event.gamma;
      if (tmp_gamma > 45) tmp_gamma = -90;
      else if (tmp_gamma > 0) tmp_gamma = 0;
      tmp_gamma = 0.00125 * tmp_gamma + 0.175;
      tmp_gamma = Math.min(Math.max(tmp_gamma, mingamma), maxgamma);
      gamma = tmp_gamma;
    }

    document.addEventListener('DOMContentLoaded', () => {
      socket = io(`${window.location.hostname}:8080`);
      intervalId = setInterval(sendToPi, 50);
      window.addEventListener('deviceorientation', handleOrientation);
      document.getElementById('connStatus').textContent = 'Yes';
      alert('Ready -- Let’s race!');

      socket.on('disconnect', () => {
        document.getElementById('connStatus').textContent = 'No';
        alert('Lost connection to Pi!');
      });
    });
  </script>
</head>
<body style="background-color: teal; font-family: sans-serif; text-align: center; color: white;">
  <h1>picar</h1>
  <p><a href="https://github.com/lawsonkeith/picar" style="color: white;">Project GitHub</a></p>
  <div id="status">
    <p>Beta: <span id="betaVal">--</span></p>
    <p>Gamma: <span id="gammaVal">--</span></p>
    <p>Connected: <span id="connStatus">No</span></p>
  </div>
</body>
</html>
