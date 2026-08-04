'use strict';

// Validation and persistence for operator-set video parameters.
//
// Two defects motivate this module, and they compound into "video settings don't
// take", which is how the operator experienced it:
//
//   1. NOTHING PERSISTED THEM. `streams/webrtc.js` held the params in a module-level
//      `let params = {...}` seeded from the config. `setParams()` mutated that object
//      and wrote mediamtx.yml, and nothing else. So every picar restart — every
//      deploy, every reboot — silently reverted the operator's tuning to the tracked
//      default. Measured: a UI change to 650 kbps at 18:30 was discarded by a restart
//      at 20:03 and replaced with the config value, with no indication anywhere.
//
//   2. NOTHING VALIDATED THEM. `setParams()` assigned whatever arrived:
//      `if (newParams.width !== undefined) params.width = newParams.width`. A string,
//      a NaN, an object — straight into the generated YAML. That is the same
//      unauthenticated surface as the `setVideoParams` RCE (see TASKS.md), and
//      persisting an unvalidated value would upgrade a transient bad frame rate into
//      a permanent unbootable stream config.
//
// Persisting makes (2) strictly more dangerous, so validation is not optional here:
// a whitelist of keys, finite integers only, clamped to ranges that cannot produce a
// broken encoder. Anything else is rejected and reported rather than coerced —
// silently accepting `fps: "fast"` as 0 is how a config error becomes a mystery.

const path = require('path');
const crypto = require('crypto');

// Own-property test. `name in obj` walks the prototype chain, so `constructor`,
// `toString`, `valueOf` and friends all answered true against the spec table — and
// their "spec" is a function whose .min/.max are undefined, so every numeric
// comparison was false and ANY finite value passed unbounded. Proven: a request of
// {"width":640,"constructor":7} persisted a key literally named
// "function Object() { [native code] }" into the overlay, with rejected:[].
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Bounds are deliberately generous at the top end (an operator may genuinely want
// 1080p on a good link) and conservative at the bottom, where the failure modes live:
// a 0 or negative value produces an encoder that will not start, and persisting that
// leaves a rover with no video until someone edits JSON over SSH.
const VIDEO_PARAM_SPEC = Object.assign(Object.create(null), {
  width:      { min: 160, max: 1920 },
  height:     { min: 120, max: 1080 },
  fps:        { min: 1,   max: 60   },
  bitrate:    { min: 50,  max: 8000 }, // kbps
  quality:    { min: 1,   max: 100  }, // mjpeg only, harmless elsewhere
  idr_period: { min: 1,   max: 300  },
});

// Which tracked-config key each param maps to, per codec. Explicit rather than
// derived: a codec whose keys are not listed here persists NOTHING, and says so,
// instead of quietly writing keys the driver never reads.
const OVERLAY_KEYS_BY_CODEC = Object.assign(Object.create(null), {
  webrtc: {
    width:      'webrtc_width',
    height:     'webrtc_height',
    fps:        'webrtc_fps',
    bitrate:    'webrtc_bitrate_kbps',
    idr_period: 'webrtc_idr_period',
  },
  h264: {
    width:   'h264_width',
    height:  'h264_height',
    fps:     'h264_framerate',
    bitrate: 'h264_bitrate_kbps',
  },
  mjpeg: {
    // mjpeg has no width/height/bitrate keys in the tracked config — only a drop
    // threshold — so there is nothing to persist. Listed explicitly so the caller
    // gets an empty mapping rather than a lookup miss it might mistake for a bug.
  },
});

// Coerce and bound one operator-supplied value. Returns null when the value cannot
// be used, so the caller can report it instead of writing a broken config.
function sanitizeOne(name, raw) {
  if (!has(VIDEO_PARAM_SPEC, name)) return null;
  const spec = VIDEO_PARAM_SPEC[name];
  // A numeric STRING is accepted here, unlike the param overlay, because these values
  // arrive from HTML form controls where "20" is the normal representation. What is
  // rejected is anything that is not a finite number after conversion.
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Number(raw) : NaN);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < spec.min || rounded > spec.max) return null;
  return rounded;
}

// Filter an operator request down to values that are safe to apply AND to persist.
// Reports everything dropped: a rejected setting that vanishes silently is
// indistinguishable from one that was applied, which is the exact confusion this
// whole module exists to end.
function sanitizeVideoParams(input) {
  const params = Object.create(null);
  const rejected = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { params: { ...params }, rejected: [`request is ${Array.isArray(input) ? 'an array' : typeof input}, not an object`] };
  }
  // Object.keys: own enumerable only. Note JSON.parse DOES create an own "__proto__"
  // property (it does not invoke the setter), so over-the-wire requests carrying it
  // are seen here and rejected by name rather than silently swallowed.
  for (const name of Object.keys(input)) {
    const raw = input[name];
    if (!has(VIDEO_PARAM_SPEC, name)) {
      rejected.push(`${name} is not a settable video parameter`);
      continue;
    }
    const value = sanitizeOne(name, raw);
    if (value === null) {
      const s = VIDEO_PARAM_SPEC[name];
      rejected.push(`${name}=${JSON.stringify(raw)} is not an integer in ${s.min}..${s.max}`);
      continue;
    }
    params[name] = value;
  }
  // Spread to a normal prototype on the way out: the null prototype protects
  // CONSTRUCTION, and every surviving key is whitelisted, so the returned object is
  // safe to be ordinary. Returning a null-prototype object made every caller and every
  // deepEqual assertion behave surprisingly for no added safety.
  return { params: { ...params }, rejected };
}

// Translate sanitized params into the overlay keys for a codec.
function overlayUpdatesFor(codec, params) {
  const map = OVERLAY_KEYS_BY_CODEC[codec];
  if (!map) return { updates: {}, unsupported: true };
  const updates = Object.create(null);
  for (const name of Object.keys(params)) {
    // hasOwnProperty here too: `map[name]` for an inherited name returned a truthy
    // function, so the SECOND lookup site was independently bypassable.
    if (has(map, name)) updates[map[name]] = params[name];
  }
  return { updates: { ...updates }, unsupported: false };
}

// Merge into an existing overlay object WITHOUT disturbing anything else in it.
// This file holds `rover_id`, which is the rover's identity — clobbering it would
// make the vehicle report as a different rover to the Fleet Manager. So this is a
// merge over a parsed copy, never a rewrite from a template.
function mergeOverlay(existing, updates) {
  const base = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {};
  return { ...base, ...updates };
}

// Persist to the untracked per-rover overlay, atomically and SERIALLY.
//
// The first version of this was atomic in the rename and nowhere else, and a review
// bricked a rover with two socket messages. The failure, reproduced 5/5 against a real
// filesystem:
//
//   socket.emit('setVideoParams', {width:1280,height:720,bitrate:2000});
//   socket.emit('setVideoParams', {fps:15});
//
// Both frames arrive in one segment, both handlers run in the same tick, and both wrote
// the SAME temp path — it was named `.<file>.tmp-${process.pid}`, and the pid is
// constant for the life of the process. The writes interleaved, the longer payload's
// tail survived past the shorter one's terminator, and one call renamed the torn file
// into place:
//
//   { "rover_id": 3, "webrtc_fps": 15 }0,  "webrtc_height": 720 }
//
// app.js parses this file at startup inside a try whose catch is process.exit(1), and
// the unit is Restart=always. So two unauthenticated messages produced a PERMANENT
// crash loop of the whole control plane — no UI, no override stream, no fail-safe — with
// rover_id destroyed, surviving reboot, recoverable only by SSH or physical access.
//
// Four defences, because this file gates whether the vehicle can boot at all:
//   1. Serialised per path, so two concurrent calls cannot interleave.
//   2. A unique temp name per call, so even a bug in (1) cannot collide.
//   3. O_EXCL, so an existing file — including a symlink planted by a local user, since
//      the old name was fully predictable — makes the write fail instead of following it.
//   4. fsync of the file before rename and of the directory after, so a power cut
//      cannot commit the rename with the data blocks unwritten and leave a zero-length
//      config. A rover losing supply is routine, not exotic.

// One promise chain per overlay path. Module-level: every caller in this process shares
// it, which is the point.
const writeQueues = new Map();

function enqueue(key, task) {
  const prev = writeQueues.get(key) || Promise.resolve();
  // Never let a rejection poison the chain for later writers.
  const next = prev.then(task, task);
  writeQueues.set(key, next.then(() => {}, () => {}));
  return next;
}

let tmpCounter = 0;

async function writeOverlayAtomically(overlayPath, merged, fsdep) {
  const dir = path.dirname(overlayPath);
  const unique = `${process.pid}-${++tmpCounter}-${crypto.randomBytes(6).toString('hex')}`;
  const tmp = path.join(dir, `.${path.basename(overlayPath)}.tmp-${unique}`);
  let handle = null;
  try {
    // 'wx' is O_CREAT|O_EXCL|O_WRONLY: fails if the path exists, and does not follow a
    // pre-planted symlink.
    handle = await fsdep.promises.open(tmp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    if (typeof handle.sync === 'function') await handle.sync();
    await handle.close();
    handle = null;
    await fsdep.promises.rename(tmp, overlayPath);
  } catch (err) {
    if (handle) { try { await handle.close(); } catch (_) { /* best effort */ } }
    try { await fsdep.promises.unlink(tmp); } catch (_) { /* best effort */ }
    throw err;
  }
  // Durability of the rename itself lives in the directory entry, so fsync the
  // directory too. Best effort: some filesystems refuse this, and failing here after a
  // successful rename must not report the write as failed.
  try {
    const dh = await fsdep.promises.open(dir, 'r');
    if (typeof dh.sync === 'function') await dh.sync();
    await dh.close();
  } catch (_) { /* best effort */ }
}

async function persistVideoParams({
  overlayPath,
  codec,
  params,
  fs: fsdep = require('fs'),
}) {
  const { updates, unsupported } = overlayUpdatesFor(codec, params);
  if (unsupported) {
    return { persisted: false, reason: `codec '${codec}' has no persistable video keys`, updates: {} };
  }
  if (Object.keys(updates).length === 0) {
    return { persisted: false, reason: 'nothing to persist', updates: {} };
  }

  return enqueue(path.resolve(overlayPath), async () => {
    let existing = Object.create(null);
    try {
      const text = await fsdep.promises.readFile(overlayPath, 'utf8');
      existing = JSON.parse(text);
    } catch (err) {
      // A missing overlay is normal on a fresh rover; a CORRUPT one is not, and
      // overwriting it would destroy rover_id. Refuse rather than guess.
      if (err.code !== 'ENOENT') {
        return { persisted: false, reason: `refusing to overwrite unreadable overlay: ${err.message}`, updates };
      }
    }
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      return { persisted: false, reason: 'existing overlay is not a JSON object; refusing to overwrite', updates };
    }

    try {
      await writeOverlayAtomically(overlayPath, mergeOverlay(existing, updates), fsdep);
    } catch (err) {
      return { persisted: false, reason: `write failed: ${err.message}`, updates };
    }
    return { persisted: true, reason: null, updates };
  });
}

module.exports = {
  VIDEO_PARAM_SPEC,
  writeOverlayAtomically,
  OVERLAY_KEYS_BY_CODEC,
  sanitizeVideoParams,
  overlayUpdatesFor,
  mergeOverlay,
  persistVideoParams,
};
