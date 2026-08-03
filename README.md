# picar

## Overview

A web-controlled rover platform: real-time control from a browser, on desktop or mobile (the
mobile interface can use the device IMU for tilt-based control).

> **Read `CLAUDE.md` before changing anything.** It carries the engineering directive, the ten
> safety invariants, a table of which of those actually hold today, and the mandatory
> review-and-validation pipeline. `TASKS.md` is the open-work list; `HANDOFF.md` is the state and
> history. This README covers setup and the electrical build only.

**Verified platform (rover3, 2026-08-03):** Raspberry Pi **Compute Module 4 Rev 1.1**, Debian 13
(trixie), Node **v20.19.2**. Earlier revisions of this file claimed Pi 5 / Bookworm / Node
v18.19.0 — that was wrong. **The fleet is not homogeneous**: check the target board rather than
assuming, and do not rely on Node 22 APIs.

The vehicle is equipped with:
- A Raspberry Pi camera for low-latency WebRTC video streaming
- Throttle, steering and drivetrain servos driven over MAVLink through a **Pixhawk 6C mini**
  running ArduPilot (`pwm_method: "mavproxy"`, the default). The GPIO/PWM drivers described in the
  Electrical sections below are legacy and not used on the current rovers
- A local HTTPS server that hosts the UI and control API on `:8443`

> ⚠️ **Security status.** The control plane is **unauthenticated** — any device that can reach
> `:8443` can arm and drive the vehicle — and there are open P0 defects allowing remote code
> execution and cross-origin access. Do not put a rover on an untrusted network. See `TASKS.md`.

Originally derived from the original Pi RC car project by [lawsonkeith](https://github.com/XXX/picar), this version:
- Replaced `pi-blaster` first with direct `sysfs`/`libgpiod` PWM, and then with MAVLink to an
  ArduPilot flight controller — which is what the rovers run today
- Uses current node.js and npm practices
- Supports modern mobile orientation APIs

## Hardware Setup
- **Platform**: Raspberry Pi Compute Module 4 (rover3); Pi 4B+ / Pi 5 also supported
- **Flight controller**: Pixhawk 6C mini running ArduPilot (ArduRover), reached over MAVLink via
  `mavproxy.service` on `/dev/ttyACM0`
- **Servos**: driven by the flight controller from `RC_CHANNELS_OVERRIDE` at 20 Hz. The legacy
  direct-GPIO drivers (`sysfs`, `libgpiod`, `pigpio`) still exist but are not used
- **Camera**: Raspberry Pi camera via MediaMTX (`rpiCamera`); a USB webcam on `/dev/video0` works
  with the `h264`/`mjpeg` fallbacks
- **Network**: Typically a smartphone hotspot or shared LAN for local control

## Electrical
This project is based on [shaunuk/picar] but replaces the servo board with a soft PWM driver on the Pi’s GPIO pins. I've provided the option to use either an isolated supply for the Pi or to use the supply off the ESC. The latter is the most elegant solution but has issues with the motor pulling the battery voltage down and causing the Pi to reset.

There's a video of the project here:

<dummy video>

### Pi Power Supply
When it comes to powering the Pi it is necessary to have a stable 5V power supply otherwise the Pi will reset. I've provided 2 methods of powering the Pi; one using a 7.2V AA battery pack and a 5V USB battery or linear regulator to give a clean 5V supply and one that uses the ESC power supply and uses a software algorithm to stop the motor accidentally resetting the Pi.

There are a number of RC car electrical setups but my example uses an ESC and receiver with battery eliminator circuit. The electronics supply normally comes from the ESC and powers the receiver and steering servo with 5V. The receiver normally receives commands from the radio controller then sends them to the ESC (throttle) and steering servo (steering). These commands fall within the 0-5V supplied by the ESC.

### Servo Signal Levels
We'll be using PWM to control the servos which will be capable of driving 0–3.3V in 3.3mV steps; it is therefore necessary first to measure what your servo command signal voltage levels are and check they fall within this range. You can do this with a multi-meter connected to the receiver pins. On my car speed and steering both use 3-pin headers which are wired:

- Gnd - Black
- Power - Red
- Throttle / Steer - Orange or White

For my car the throttle voltages were:
- Full Fwd:     0.19V
- Idle:         0.28V
- Full Reverse: 0.36V

The steering voltages were:
- Full Left:    0.19V
- Fwds:         0.28V
- Full Right:   0.355V

### Pi with Isolated Supply
Once you are happy about how you are going to power your Pi and that the GPIO are up to the job you can start thinking about wiring it up.

![](https://github.com/XXX/picar/raw/master/media/picar_scematic.PNG)

For the 3-pin headers I used 2.54mm PCB header and soldered the wires direct. I then used superglue to stop the pins moving about. You'll also need heat-shrink or equivalent to cover over the solder joints.

To power the Pi I chopped a micro USB cable and used the black and red wires from that as my 5V supply. For my linear power supply I used an LM7805 circuit and put a heatsink on it to keep it nice and cool. I'd recommend using a different LDO regulator if you have one though; this circuit will stop working at 7V; a LM2940CT will regulate down to 5.5V and would be a much better option.

![](https://github.com/XXX/picar/raw/master/media/reg cct.PNG)

I then attached a PP3 battery clip and 6xAA pack with a PP3 connector on it. I've also used a 26w header socket to attach to the Raspberry Pi GPIO lines; I like this method as it means it's hard to mis-wire when re-connecting plus you can quickly remove your Pi as required.

I've covered my regulator circuit in heatshrink to keep it protected. You can see I've also got some protection on my header pins in case a wire falls off.

![](https://github.com/XXX/picar/raw/master/media/DSC1499.jpg)
![](https://github.com/XXX/picar/raw/master/media/DSC_0219.jpg)
![](https://github.com/XXX/picar/raw/master/media/DSC_0220.jpg)
![](https://github.com/XXX/picar/raw/master/media/DSC_0221.jpg)

### Pi using ESC Supply
If you opt for this approach the wiring is much simpler; also there's a lot more room in the car. The only issue is you may have to play around with the motor demand rate-of-change limiting algorithm in `app.js` to get to a point where your Pi doesn't keep resetting because of voltage drop caused by the motor loading the battery. You can control this problem quite effectively by controlling the rate of change of the speed demand that's allowed to be sent to the ESC from the Pi. The amount of rate limiting you require will depend on:

- Motor power (stock being best)
- Battery technology (NiMH better than NiCad)
- Battery capacity and condition
- Drive type (2WD better than 4WD)
- Efficiency of ESC power supply circuitry
- How the ESC reverse works (brake → reverse can cause a big demand change)
- Running surface (grass being worst)

![](https://github.com/XXX/picar/raw/master/media/picar_scematic_nobat.PNG)
![](https://github.com/XXX/picar/raw/master/media/DSCF1517.jpg)
![](https://github.com/XXX/picar/raw/master/media/DSCF1515.jpg)

## Software Setup

### Install

**Use `install.sh`.** It is the supported path and handles Node packages, the Python venv for
MAVProxy, the MediaMTX binary, the systemd units (templating the run user and repo path), and the
polkit rule that lets the non-root service restart MediaMTX.

```bash
# The repo lives at /opt/picar on every rover — this is the standing convention,
# and the tracked systemd units carry /opt/picar paths.
sudo git clone <your-fork-url> /opt/picar
cd /opt/picar
sudo ./install.sh --picar     # or --fleet for the Fleet Manager
```

It prompts for the run user, the rover ID, whether to use MAVProxy, and the camera type.

Dependencies come from `package.json` via `npm ci --omit=dev` — do **not** hand-install a subset
(an earlier revision of this file said `npm install socket.io node-static`, which omits `ws` and
leaves the h264 stream broken).

> **Two known installer defects** (`TASKS.md`, P1): re-running `install.sh` rewrites the *tracked*
> `picar-cfg.json`, leaving a permanently dirty tree; and it uses `systemctl enable --now`, which
> does **not** restart an already-running unit — so a re-run after `git pull` will not deploy the
> new code. Restart explicitly:
> ```bash
> sudo systemctl restart picar mavproxy mediamtx
> ```

### PWM Support for Raspberry Pi 5 — *legacy, not used on the current rovers*

> Everything in this section applies only to `pwm_method` values of `sysfs`, `libgpiod`,
> `pigpion` or `pigpiod`. The rovers run `pwm_method: "mavproxy"`, where the flight controller
> drives the servos and none of this is needed. **These drivers also have open defects**
> (`TASKS.md`): none implements the fail-safe primitive, so on a GPIO rover every fail-safe path
> is a silent no-op; `libgpiod` spawns ~200 `execSync` calls per second; and `pigpiod` is
> non-functional. Do not switch a vehicle to a GPIO driver without reading those entries first.

To allow non-root users to access PWM devices via sysfs, create a udev rules file at `/etc/udev/rules.d/99-pwm-permissions.rules`:

```bash
sudo nano /etc/udev/rules.d/99-pwm-permissions.rules
```

Insert the following:
```udev
SUBSYSTEM=="pwm", KERNEL=="pwmchip*", MODE="0777", GROUP="gpio"
SUBSYSTEM=="pwm", KERNEL=="pwm*", MODE="0777", GROUP="gpio"
```

Then reload udev rules:
```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
```
PWM output to the servos is handled through `pwm_servo.js`, which uses the `/sys/class/pwm` interface. On Raspberry Pi 5, this works with kernel support, but may require enabling the `pwm` overlay in `/boot/firmware/config.txt`:

```ini
# Enable PWM channels
dtoverlay=pwm-2chan
```

Ensure your user has access to `/sys/class/pwm` or run the app as root.

Be sure you are a member of the gpio group

```bash
sudo usermod -aG gpio $USER
```
or just add your username to the end of the "gpio" line in /etc/group

```bash
sudo vi /etc/group # comma separated list of user names
```
AND change the group of /dev/gpio

```bash
sudo chgrp gpio /dev/pigpio
```


### Network Configuration
Ensure both devices are connected to the same network.

To use your smartphone as a hotspot:

- On your iPhone, enable the Personal Hotspot.
- On the Raspberry Pi:
  1. Use the GUI or `nmtui` (NetworkManager) to scan for and connect to the iPhone hotspot.
  2. Save the connection for automatic reconnect.
  3. Ensure the Pi receives an IP address and has internet access through the hotspot.

This allows your mobile device to connect to the Pi's services over a local secure HTTPS connection.

### Video Streaming

The default video path is WebRTC through MediaMTX:

```text
Pi camera -> MediaMTX WHEP/WebRTC (:8889) -> socket.html <video>
```

This is the preferred mode for Firefox, Chrome, Edge, Safari, and mobile browsers. It is also more tolerant of fast motion than MJPEG or the experimental raw H.264/WebCodecs path because the browser receives a normal WebRTC stream with jitter buffering and congestion behavior.

The repo keeps the older streams as diagnostics:

- `stream_codec: "webrtc"`: default; requires `mediamtx.service`.
- `stream_codec: "h264"`: raw H.264 over WebSocket; works best in Chrome/Edge.
- `stream_codec: "mjpeg"`: simple MJPEG fallback; high bandwidth and prone to stalls during motion.

**`mediamtx.yml` is generated, not edited.** `streams/webrtc.js` regenerates it from
`picar-cfg.json` at every startup, and it is `.gitignore`d — hand edits are silently overwritten on
the next restart. Change the `webrtc_*` keys in `picar-cfg.json` instead.

The default is a stability-first `480x360@20fps`, 350 kbps H.264 baseline, IDR every 10 frames
(`webrtc_width`, `webrtc_height`, `webrtc_fps`, `webrtc_bitrate_kbps`, `webrtc_idr_period`). If
fast motion still freezes the feed, lower `webrtc_bitrate_kbps` or switch `webrtc_codec` from
`hardwareH264` to `softwareH264` for a test run.

### HTTPS Certificates

The app runs on HTTPS, which browsers require before they will allow camera access, WebSockets, and WebRTC.

> 🔴 **The repo currently ships a CA and server certificate — including both private keys**
> (`certs/ca.key`, `certs/key.pem` are tracked). **Treat them as compromised.** Anyone with repo
> read access can mint a certificate that every device trusting this CA will accept. Generate your
> own with `setup-certs.sh` below and never rely on the committed pair. Rotating the CA and
> untracking the keys is an open P0 in `TASKS.md`; note that `install.sh` does not yet provision
> certs, so they cannot simply be deleted.

The `certs/setup-certs.sh` script creates:
- a **local CA** (`ca.crt`) that you install on your devices once
- a **server certificate** (`cert.pem` + `key.pem`) signed by that CA

Once the CA is trusted, Safari, Chrome, and Firefox accept the picar servers with no warning or manual cert-acceptance popup.

#### 1 — Generate certificates on the Pi

```bash
cd /path/to/picar/certs
bash setup-certs.sh
```

The script prompts for your Pi's IP address or hostname (e.g. `192.168.1.42` or `picar.local`) and writes `ca.crt`, `cert.pem`, and `key.pem` into the `certs/` directory.

> **If your Pi's IP changes** re-run the script and restart the app. You do **not** need to reinstall `ca.crt` on your devices — only the server cert needs to change.

#### 2 — Serve ca.crt so devices can download it

A quick way to make `ca.crt` available over the local network:

```bash
cd /path/to/picar/certs
python3 -m http.server 8000
```

Then on each client device browse to `http://<pi-ip>:8000/ca.crt`.

#### 3 — Install ca.crt on Linux (Chrome / Firefox)

```bash
# Chrome / Chromium — add to the system NSS shared DB
certutil -d sql:$HOME/.pki/nssdb -A -t "CT,," -n "PiCar Local CA" -i ca.crt

# Firefox — add to its own cert store
certutil -d sql:$HOME/.mozilla/firefox/*.default-release -A -t "CT,," -n "PiCar Local CA" -i ca.crt

# System-wide (Debian / Ubuntu / Raspberry Pi OS) — affects curl, wget, etc.
sudo cp ca.crt /usr/local/share/ca-certificates/picar-ca.crt
sudo update-ca-certificates
```

> `certutil` comes from the `libnss3-tools` package: `sudo apt install libnss3-tools`

#### 4 — Install ca.crt on iPhone / iPad (Safari)

1. Open `http://<pi-ip>:8000/ca.crt` in Safari — iOS prompts **"Profile Downloaded"** → tap **Close**
2. **Settings → General → VPN & Device Management** → tap **PiCar Local CA** → **Install** → enter passcode → **Install**
3. **Settings → General → About → Certificate Trust Settings** → toggle on **PiCar Local CA** → **Continue**

#### 5 — Install ca.crt on Android (Chrome)

1. Download `ca.crt` from the Pi
2. **Settings → Security → Encryption & credentials → Install a certificate → CA certificate** → select the file

#### 6 — Install ca.crt on macOS (Safari / Chrome)

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.crt
```

#### 7 — Install ca.crt on Windows (Edge / Chrome)

1. Double-click `ca.crt` → **Install Certificate**
2. Select **Local Machine** → **Place all certificates in the following store** → **Trusted Root Certification Authorities** → **Finish**

---

### Running the Application

`install.sh` installs and enables the services, so on a provisioned rover picar is already
running and starts at boot. To operate it:

```bash
sudo systemctl restart picar          # picar.service — UI + control on :8443
sudo systemctl status picar mavproxy mediamtx
journalctl -u picar -f                # follow the log
```

Do **not** run `sudo node app.js` by hand: it bypasses the systemd unit and runs as the wrong user.
It is also easy to lose the shutdown fail-safe — `app.js` handles only `SIGINT`, so while Ctrl-C
does run the handler, anything that stops it with `SIGTERM` (`kill`, a supervisor, a script)
**skips the neutral + DISARM entirely**. The unit avoids this with `KillSignal=SIGINT`.
Open a browser and go to:
```
https://<raspberry-pi-ip>:8443/socket.html
```
The control UI connects to the MediaMTX WHEP endpoint internally:
```
https://<raspberry-pi-ip>:8889/cam/whep
```
Open `socket.html` for an actual browser view of the WebRTC stream.
To view the legacy MJPEG stream when `stream_codec` is set to `mjpeg`:
```
https://<raspberry-pi-ip>:8081/stream.mjpg
```

### Running on Boot

Nothing to write by hand — the units are **tracked in `systemd/`** and installed by `install.sh`,
which templates `User=` and rewrites the `/opt/picar` placeholder to the real repo path:

| Unit | Role |
| --- | --- |
| `picar.service` | UI + control server (`:8443`) and stream server (`:8081`) |
| `mavproxy.service` | MAVProxy bridging `/dev/ttyACM0` to TCP `:5760` |
| `mediamtx.service` | WebRTC/WHEP video (`:8889`) |
| `fleet-manager.service` | Fleet Manager dashboard (`:3000`, `--fleet` installs only) |

Edit the files in `systemd/` and re-run `install.sh` rather than editing
`/lib/systemd/system/*.service` directly, or your change will be overwritten.

> `picar.service` sets `KillSignal=SIGINT` with `TimeoutStopSec=5` so `app.js` can flush a final
> neutral + DISARM before exiting. **Do not change that without re-validating shutdown behaviour**
> — `app.js` handles only `SIGINT`, so switching to the default `SIGTERM` silently removes the
> shutdown fail-safe.

## Fleet Manager

The Fleet Manager is a standalone dashboard (`fleet-manager/server.js`, port `3000`) that
tracks multiple rovers. Each rover periodically POSTs a heartbeat (`id`, `ip`, `status`) to
it, and the dashboard lists every rover with a link to its controller UI.

Install it on any Linux machine (a laptop is fine) with:

```bash
sudo ./install.sh --fleet
```

### How rovers find the Fleet Manager (`fleetManagerUrl`)

Each rover's `picar-cfg.json` has:

```json
"fleetManagerUrl": "auto"
```

- **`"auto"` (default, recommended)** — the rover sweeps its own `/24` over plain unicast TCP
  for a host answering `GET /api/fleet-id`, locks onto it, and heartbeats there, re-discovering
  automatically if the FM moves or restarts. This is **OS-agnostic**: it works no matter where
  the FM runs (native Linux, WSL, Windows, Pi, Mac) because it relies only on unicast TCP — the
  one transport that survives WSL's NAT (mDNS/broadcast do not). No IP, no hostname, no per-rover
  setup.
- **`"http://host:port"`** — an explicit fixed address, if you prefer to pin it.
- **`""`** — disables the heartbeat.

> For auto-discovery the FM and rovers must share a subnet (the sweep is `/24`-scoped), and the
> FM host must accept inbound TCP on port `3000` (open the firewall; if the FM runs in WSL, use
> mirrored networking so it sits on the real LAN rather than a `172.x` NAT address).

### Per-rover identity (`picar-cfg.local.json`)

`rover_id` is **not** in the tracked `picar-cfg.json` — it lives in an untracked overlay,
`picar-cfg.local.json`, so the tracked config can be updated / `git pull`ed without clobbering
each rover's identity (and no two rovers collide on the dashboard). `install.sh` prompts for an
integer ID and writes it there; `app.js` shallow-merges the overlay over the tracked config at
startup (absent ⇒ defaults to `1`). To set it by hand:

```json
{ "rover_id": 2 }
```

### Legacy: mDNS alias (`fleet-manager.local`)

Before auto-discovery, rovers reached the FM by a fixed mDNS name published by
`avahi-fleet-alias.service` (still installed by `--fleet`). This only works when the FM runs on
a machine natively on the LAN — it fails from WSL, whose mDNS can't advertise across NAT. Prefer
`"auto"`; use `"fleetManagerUrl": "http://fleet-manager.local:3000"` only if you specifically
want a fixed name.

Verify the FM is up from any machine on the LAN:

```bash
curl http://<fleet-manager-ip>:3000/api/rovers
```
